import { guarded, may } from '../auth/guard';
import { includesSuperviseeCaseloads, ownCaseloadOnly, type Actor, type Target } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { NotFound } from '../errors';
import { coverageOf } from '../staff/coverage';
import { leavePhase } from '../staff/leave';
import { localDateOf } from '../time';

/**
 * The relationship facts a check needs about a client: who treats them, who
 * supervises that person, and who covers the client while they are away.
 * Resolved once, from data, and handed to the matrix — which is what lets
 * reassigning a supervisor, or recording a leave, change access with no deploy.
 *
 * `today` travels with the coverage and `covers` decides whether the leave is
 * on (leave D-14), so the grant ends at midnight whether or not anything ran.
 */
export async function clientTarget(clientId: string, clock: Clock = systemClock) {
  const row = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      treatingClinicianId: true,
      treatingClinician: { select: { supervisorId: true } },
    },
  });
  if (!row) throw new NotFound('Client');
  const today = localDateOf(clock.now());
  const coverage = (await coverageOf(prisma, [row], today)).get(clientId);
  return {
    clinicianId: row.treatingClinicianId,
    treatingSupervisorId: row.treatingClinician.supervisorId ?? undefined,
    today,
    ...(coverage && { coverage }),
  } satisfies Target;
}

/**
 * The client record, as front desk and as a clinician.
 *
 * There is one row and two readings of it, and the difference is enforced by
 * which resource a call is guarded on rather than by which fields a component
 * remembers to leave out. Session focus, screener scores and notes are not
 * "fields front desk shouldn't render" — they are different resources that
 * front desk cannot reach, and reaching for one produces a logged 403.
 */

const DEMOGRAPHICS = {
  id: true, code: true, firstName: true, lastName: true, dateOfBirth: true,
  email: true, phone: true,
  emergencyContactName: true, emergencyContactPhone: true, emergencyContactRelation: true,
  treatingClinicianId: true, feeCents: true, reminderPreference: true, reminderStages: true,
  language: true, status: true,
  referralSource: true, referralNote: true,
  createdAt: true,
} as const;

/**
 * Consents still owed. Front desk needs this loudly: seeing a client without
 * signed consent on file is a liability event, so it is deliberately part of
 * the operational record rather than something buried in a forms tab.
 */
export async function consentStatus(clientId: string) {
  const requests = await prisma.formRequest.findMany({
    where: { clientId, template: { kind: 'consent' } },
    select: { id: true, status: true, submittedAt: true, template: { select: { name: true, key: true } } },
    orderBy: { sentAt: 'asc' },
  });
  const outstanding = requests.filter((r) => r.status !== 'submitted');
  return {
    complete: requests.length > 0 && outstanding.length === 0,
    neverSent: requests.length === 0,
    outstanding: outstanding.map((r) => ({ id: r.id, name: r.template.name, key: r.template.key })),
  };
}

export async function getClient(actor: Actor, clientId: string, clock: Clock = systemClock) {
  const target = await clientTarget(clientId, clock);

  return guarded(
    { actor, action: 'read', resource: 'client', resourceId: clientId, clientId, target },
    async (tx) => {
      const client = await tx.client.findUniqueOrThrow({
        where: { id: clientId },
        select: {
          ...DEMOGRAPHICS,
          treatingClinician: { select: { id: true, name: true, role: true, supervisorId: true } },
          // P1-2: who this client was transferred from and to, and when. Names
          // and a date at the demographic tier, so front desk can answer the
          // phone — never the disposition, and nothing else a plan decided.
          departureAssignments: {
            where: { disposition: 'transfer', departure: { status: 'executed' } },
            select: {
              id: true,
              receivingClinician: { select: { name: true } },
              departure: { select: { executedAt: true, user: { select: { name: true } } } },
            },
            orderBy: { departure: { executedAt: 'desc' } },
          },
        },
      });
      return { ...client, consents: await consentStatus(clientId) };
    },
  );
}

/**
 * The clients a role is scoped to, as a `where` fragment.
 *
 * A supervisor's caseload is their own plus their supervisees'. Anybody
 * covering a leave also has the clients they cover today. Front desk gets no
 * fragment because they book for everyone, and the practice manager never
 * reaches a query that uses this — their client read is break-glass.
 *
 * `AND`, so a caller's own `OR` (a search) cannot overwrite the scope.
 */
async function caseloadWhere(actor: Actor, clock: Clock = systemClock) {
  if (!ownCaseloadOnly(actor)) return {};
  const [supervisees, covered] = await Promise.all([
    includesSuperviseeCaseloads(actor)
      ? prisma.user.findMany({ where: { supervisorId: actor.id }, select: { id: true } }).then((us) => us.map((u) => u.id))
      : [],
    coveredClientIds(actor, localDateOf(clock.now())),
  ]);
  return {
    AND: [{ OR: [{ treatingClinicianId: { in: [actor.id, ...supervisees] } }, { id: { in: covered } }] }],
  };
}

/**
 * The clients this person covers today, each admitted by the same `client.read`
 * the record itself asks, so the list never names a client the record would
 * refuse — the leave-level coverer does not see a client split to somebody else.
 */
async function coveredClientIds(actor: Actor, today: string): Promise<string[]> {
  const leaves = await prisma.leave.findMany({
    where: {
      cancelledAt: null,
      toDate: { gte: new Date(`${today}T00:00:00Z`) },
      OR: [{ coveringClinicianId: actor.id }, { coverage: { some: { coveringClinicianId: actor.id } } }],
    },
    select: { userId: true },
  });
  if (leaves.length === 0) return [];
  const clients = await prisma.client.findMany({
    where: { treatingClinicianId: { in: leaves.map((l) => l.userId) } },
    select: { id: true, treatingClinicianId: true },
  });
  const coverage = await coverageOf(prisma, clients, today);
  return clients
    .filter((c) => may({
      actor, action: 'read', resource: 'client',
      target: { clinicianId: c.treatingClinicianId, coverage: coverage.get(c.id), today },
    }))
    .map((c) => c.id);
}

/** The relationship facts a caseload-wide read asserts about itself. */
const OWN_CASELOAD = (actor: Actor) => ({ clinicianId: actor.id, treatingSupervisorId: actor.id });

/**
 * The caseload list. A clinician sees their own clients; front desk sees
 * everyone, because they book for everyone.
 *
 * Listing is guarded once rather than per row: a list is a single access event,
 * and one audit row per client on a page of forty would bury the individual
 * record opens that actually matter.
 */
export async function listClients(actor: Actor, opts: { search?: string; clock?: Clock } = {}) {
  const clock = opts.clock ?? systemClock;
  const scope = await caseloadWhere(actor, clock);

  const rows = await guarded(
    { actor, action: 'read', resource: 'client', target: OWN_CASELOAD(actor) },
    (tx) =>
      tx.client.findMany({
        where: {
          ...scope,
          ...(opts.search
            ? {
                OR: [
                  { firstName: { contains: opts.search, mode: 'insensitive' as const } },
                  { lastName: { contains: opts.search, mode: 'insensitive' as const } },
                  { code: { contains: opts.search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        select: { ...DEMOGRAPHICS, treatingClinician: { select: { id: true, name: true } } },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
  );

  // Leave P1-2: "covering until …" on the rows a person has because they cover
  // them today. Display only — the matrix already decided which rows these are.
  const today = localDateOf(clock.now());
  const others = ownCaseloadOnly(actor) ? rows.filter((c) => c.treatingClinician.id !== actor.id) : [];
  const coverage = await coverageOf(prisma, others.map((c) => ({ id: c.id, treatingClinicianId: c.treatingClinician.id })), today);
  return rows.map((c) => {
    const k = coverage.get(c.id);
    return { ...c, coveringUntil: k?.coveringClinicianId === actor.id && leavePhase(k, today) === 'active' ? k.toDate : null };
  });
}

/**
 * "We may already know this person" (P1-2).
 *
 * A warning, never a block, and it follows the record rather than standing in
 * front of it — nobody on a phone waits while we decide whether we have met
 * them. If the match is real, `duplicate` is already in the discard vocabulary
 * and that is how the call ends.
 *
 * Codes, and nothing else. A match says a record exists to go and look at; it
 * says nothing about the person in it, and nothing is written down either. A
 * matched id stored on the enquiry would be a client id on a row built to be
 * destroyed, which is the one thing P0-1 exists to prevent.
 *
 * Scoped by the same rule as the caseload list, so this discloses nothing the
 * matrix does not already allow: front desk matches against everyone, a
 * clinician against the clients they treat, and the practice manager gets no
 * match at all rather than a reason to break glass over a phone number. `may`
 * rather than `guarded` for that last one — nobody asked to open a record, and
 * a denial row per recorded call would bury the denials that mean something.
 *
 * Matching is exact. A number typed with different punctuation is missed, and
 * a warning that sometimes misses is the failure this is allowed to have; a
 * warning that sometimes blocks is not.
 */
export async function possibleDuplicates(
  actor: Actor,
  contact: { phone?: string | null; email?: string | null },
): Promise<{ id: string; code: string }[]> {
  const OR = [
    ...(contact.phone ? [{ phone: contact.phone }] : []),
    ...(contact.email ? [{ email: { equals: contact.email, mode: 'insensitive' as const } }] : []),
  ];
  // Nothing to match on is not an access event, so it is not an audit row.
  if (OR.length === 0 || !may({ actor, action: 'read', resource: 'client', target: OWN_CASELOAD(actor) })) {
    return [];
  }
  const scope = await caseloadWhere(actor);

  return guarded(
    { actor, action: 'read', resource: 'client', target: OWN_CASELOAD(actor) },
    (tx) =>
      tx.client.findMany({
        where: { ...scope, OR },
        select: { id: true, code: true },
        orderBy: { code: 'asc' },
      }),
  );
}

export type ClientEdit = Partial<{
  firstName: string; lastName: string; email: string | null; phone: string | null;
  emergencyContactName: string | null; emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  reminderPreference: 'email' | 'sms' | 'none';
  /// Empty means the practice cadence. See `cadenceStages`.
  reminderStages: ('d5' | 'd1' | 'd0')[];
  /// Which set of message bodies — and which deny-list. See `DENY_LISTS`.
  language: 'en' | 'es';
  status: 'active' | 'inactive';
  treatingClinicianId: string;
  /// How they found us. Demographics, not a clinical answer — see D-04.
  referralSource: 'gp' | 'friend' | 'search' | 'other' | null;
  referralNote: string | null;
}>;

export async function updateClient(actor: Actor, clientId: string, data: ClientEdit) {
  const target = await clientTarget(clientId);

  return guarded(
    { actor, action: 'update', resource: 'client', resourceId: clientId, clientId, target },
    (tx) => tx.client.update({ where: { id: clientId }, data, select: DEMOGRAPHICS }),
  );
}

export async function createClient(
  actor: Actor,
  data: { code: string; firstName: string; lastName: string; dateOfBirth: Date; treatingClinicianId: string } & ClientEdit,
) {
  return guarded(
    { actor, action: 'create', resource: 'client' },
    (tx) => tx.client.create({ data, select: DEMOGRAPHICS }),
  );
}

/**
 * The fee is its own resource so the practice manager can run the business
 * without breaking glass into a clinical record to change a number.
 */
export async function setFee(actor: Actor, clientId: string, feeCents: number | null) {
  if (feeCents !== null && (!Number.isInteger(feeCents) || feeCents < 0)) {
    throw new TypeError('Fees are integer cents, and not negative');
  }
  return guarded(
    { actor, action: 'update', resource: 'fee', resourceId: clientId, clientId },
    (tx) => tx.client.update({ where: { id: clientId }, data: { feeCents }, select: { id: true, feeCents: true } }),
  );
}

export async function effectiveFeeCents(clientId: string): Promise<number> {
  const [client, settings] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { feeCents: true } }),
    prisma.practiceSettings.findUnique({ where: { id: 1 } }),
  ]);
  return client?.feeCents ?? settings?.standardFeeCents ?? 18000;
}

/** What the current actor may do with this record, for rendering affordances. Pass `clientTarget`'s answer. */
export function clientAffordances(actor: Actor, target: Target) {
  return {
    edit: may({ actor, action: 'update', resource: 'client', target }),
    setFee: may({ actor, action: 'update', resource: 'fee', target }),
    readProgressNotes: may({ actor, action: 'read', resource: 'progress_note', target: { ...target, authorId: actor.id } }),
    readScreeners: may({ actor, action: 'read', resource: 'form_submission', target }),
    readAttendance: may({ actor, action: 'read', resource: 'attendance_history', target }),
    /** Does this person ever author process notes? Front desk and admin do not. */
    authorsProcessNotes: may({ actor, action: 'read', resource: 'process_note', target: { authorId: actor.id } }),
    isTreatingClinician: actor.id === target.clinicianId,
  };
}
