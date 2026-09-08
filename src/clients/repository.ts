import { guarded, may } from '../auth/guard';
import { includesSuperviseeCaseloads, ownCaseloadOnly, type Actor } from '../auth/permissions';
import { prisma } from '../db';
import { NotFound } from '../errors';

/**
 * The relationship facts a check needs about a client: who treats them, and who
 * supervises that person. Resolved once, from data, and handed to the matrix —
 * which is what lets reassigning a supervisor change access with no deploy.
 */
export async function clientTarget(clientId: string) {
  const row = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      treatingClinicianId: true,
      treatingClinician: { select: { supervisorId: true } },
    },
  });
  if (!row) throw new NotFound('Client');
  return {
    clinicianId: row.treatingClinicianId,
    treatingSupervisorId: row.treatingClinician.supervisorId ?? undefined,
  };
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

export async function getClient(actor: Actor, clientId: string) {
  const target = await clientTarget(clientId);

  return guarded(
    { actor, action: 'read', resource: 'client', resourceId: clientId, clientId, target },
    async (tx) => {
      const client = await tx.client.findUniqueOrThrow({
        where: { id: clientId },
        select: {
          ...DEMOGRAPHICS,
          treatingClinician: { select: { id: true, name: true, role: true, supervisorId: true } },
        },
      });
      return { ...client, consents: await consentStatus(clientId) };
    },
  );
}

/**
 * The caseload list. A clinician sees their own clients; front desk sees
 * everyone, because they book for everyone.
 *
 * Listing is guarded once rather than per row: a list is a single access event,
 * and one audit row per client on a page of forty would bury the individual
 * record opens that actually matter.
 */
export async function listClients(actor: Actor, opts: { search?: string } = {}) {
  const mineOnly = ownCaseloadOnly(actor);
  // A supervisor's list is their own caseload plus their supervisees'.
  const supervisees = includesSuperviseeCaseloads(actor)
    ? (await prisma.user.findMany({ where: { supervisorId: actor.id }, select: { id: true } })).map((u) => u.id)
    : [];

  return guarded(
    {
      actor, action: 'read', resource: 'client',
      target: { clinicianId: actor.id, treatingSupervisorId: actor.id },
    },
    (tx) =>
      tx.client.findMany({
        where: {
          ...(mineOnly ? { treatingClinicianId: { in: [actor.id, ...supervisees] } } : {}),
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

/** What the current actor may do with this record, for rendering affordances. */
export function clientAffordances(
  actor: Actor,
  treatingClinicianId: string,
  treatingSupervisorId?: string,
) {
  const target = { clinicianId: treatingClinicianId, treatingSupervisorId };
  return {
    edit: may({ actor, action: 'update', resource: 'client', target }),
    setFee: may({ actor, action: 'update', resource: 'fee', target }),
    readProgressNotes: may({ actor, action: 'read', resource: 'progress_note', target: { ...target, authorId: actor.id } }),
    readScreeners: may({ actor, action: 'read', resource: 'form_submission', target }),
    readAttendance: may({ actor, action: 'read', resource: 'attendance_history', target }),
    /** Does this person ever author process notes? Front desk and admin do not. */
    authorsProcessNotes: may({ actor, action: 'read', resource: 'process_note', target: { authorId: actor.id } }),
    isTreatingClinician: actor.id === treatingClinicianId,
  };
}
