import { randomUUID } from 'node:crypto';
import { guarded, guardedAll } from '../auth/guard';
import { actingStaffId, type Actor } from '../auth/permissions';
import { DAY, HOUR, systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { Conflict, NotFound } from '../errors';
import { SYSTEM_ACTOR } from '../scheduling/reminders';
import { leavePhase } from '../staff/leave';
import { localDateOf } from '../time';
import type { ClientEdit } from './repository';

/**
 * The inquiry lifecycle, in one place (hard rule 8).
 *
 * A caller becomes a client or becomes nothing, and neither is undone. Both
 * endings are terminal for the same reason the session lifecycle's are: one
 * has created a clinical record that now has its own history, and the other is
 * counting down a retention window towards being destroyed. Re-opening either
 * would mean a row whose meaning depends on how it got here.
 */
export type InquiryStatus = 'open' | 'converted' | 'discarded';

export const TRANSITIONS: Record<InquiryStatus, readonly InquiryStatus[]> = {
  open: ['converted', 'discarded'],
  converted: [],
  discarded: [],
};

export const canTransition = (from: InquiryStatus, to: InquiryStatus): boolean =>
  TRANSITIONS[from].includes(to);

/**
 * A wrong move is a refusal, never a silent no-op — the same `Conflict` a
 * session lifecycle violation raises. Silently ignoring `discarded → converted`
 * would leave the caller believing they had a client, and the retention sweep
 * still counting down on the row.
 */
export function assertTransition(from: InquiryStatus, to: InquiryStatus): void {
  if (!canTransition(from, to)) {
    throw new Conflict(`A ${from} inquiry cannot become ${to}`, 'bad_transition');
  }
}

/**
 * ─────────────────────────── the record ───────────────────────────
 *
 * Everything below persists. It is in the same file as the transition table
 * for the same reason `scheduling/lifecycle.ts` is: the rule and the only
 * writer of the column it governs should not be two files apart.
 */

/** Why an inquiry ended without a client. A code, never free text (P0-3). */
export type DiscardReason =
  | 'no_answer' | 'not_a_fit' | 'referred_out'
  | 'no_capacity' | 'chose_elsewhere' | 'duplicate' | 'spam';

export type ReferralSource = 'gp' | 'friend' | 'search' | 'other';

/**
 * What an inquiry is allowed to be. No date of birth, no client code, no
 * treating clinician — conversion is what those are for (P0-1).
 */
export interface InquiryInput {
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  requestedClinicianId?: string | null;
  referralSource: ReferralSource;
  referralNote?: string | null;
  /**
   * Which surgery sent them (P2). Meaningful only alongside `referralSource:
   * 'gp'`, and dropped rather than rejected on any other source — see
   * `createInquiry`. The database refuses the disagreeing row outright.
   */
  referrerId?: string | null;
  note?: string | null;
}

const SELECT = {
  id: true, firstName: true, lastName: true, phone: true, email: true,
  requestedClinicianId: true, assignedClinicianId: true,
  referralSource: true, referralNote: true, referrerId: true, referredOutToId: true, note: true,
  status: true, discardReason: true, discardedAt: true, takenById: true, createdAt: true,
} as const;

/**
 * Write down a call — or accept one that arrived without a call at all.
 *
 * `takenById` is the staff member behind the act, and the public enquiry form
 * has none: nobody took that one, it turned up. The null is not a gap in the
 * data, it is the fact, and `actingStaffId` decides it from the role in the one
 * module allowed to reason about roles.
 */
export async function createInquiry(actor: Actor, data: InquiryInput) {
  return guarded(
    { actor, action: 'create', resource: 'inquiry' },
    (tx) =>
      tx.inquiry.create({
        data: { ...data, ...gpOnly(data), takenById: actingStaffId(actor) },
        select: SELECT,
      }),
  );
}

/**
 * A surgery is only a fact about a `gp` referral.
 *
 * Dropped here rather than refused, because the form has no way to hide the
 * picker when the source changes and a `Conflict` would be a 500 on an
 * ordinary mis-click. What is refused is the *stored* row: the database CHECK
 * `inquiry_referrer_only_for_gp` makes the disagreeing combination
 * unrepresentable, so this function shapes and the database forbids. Two
 * mechanisms, and only one of them can be routed around.
 */
const gpOnly = (data: Partial<InquiryInput>) =>
  data.referralSource === 'gp' ? {} : { referrerId: null };

/**
 * One access event, one audit row — the same argument `listClients` makes.
 *
 * No caseload filter: a clinician sees every open inquiry, including the ones
 * that asked for somebody else, because a six-person practice discusses its own
 * intake. That is a UI default rather than a permission, and the matrix says so
 * with `read: always`.
 */
export async function listInquiries(
  actor: Actor,
  opts: { status?: InquiryStatus; assignedTo?: string } = {},
) {
  return guarded(
    { actor, action: 'read', resource: 'inquiry' },
    (tx) =>
      tx.inquiry.findMany({
        where: {
          ...(opts.status ? { status: opts.status } : {}),
          ...(opts.assignedTo ? { assignedClinicianId: opts.assignedTo } : {}),
        },
        select: SELECT,
        orderBy: { createdAt: 'desc' },
      }),
  );
}

/** The operational fields. Status is not among them — that is `discardInquiry`. */
export async function updateInquiry(
  actor: Actor,
  id: string,
  data: Partial<InquiryInput>,
) {
  return guarded(
    { actor, action: 'update', resource: 'inquiry', resourceId: id },
    // Only when the source is being written: a partial edit that leaves
    // `referralSource` alone must not silently clear a referrer the row
    // already carries legitimately.
    (tx) =>
      tx.inquiry.update({
        where: { id },
        data: data.referralSource === undefined ? data : { ...data, ...gpOnly(data) },
        select: SELECT,
      }),
  );
}

/**
 * Declare a call dead, and start the retention clock.
 *
 * `discard`, not `delete`: nothing is destroyed here. The reason code, the
 * timestamp and the audit row are one write, so there is no window in which the
 * practice has the ending without the reason for it — and no window in which a
 * row is discarded but carries no `discardedAt`, which would be a row the sweep
 * can never reach.
 */
export async function discardInquiry(
  actor: Actor,
  id: string,
  reason: DiscardReason,
  opts: { clock?: Clock; referredOutToId?: string | null } = {},
) {
  const row = await prisma.inquiry.findUnique({ where: { id }, select: { status: true } });
  if (!row) throw new NotFound('Inquiry');
  assertTransition(row.status as InquiryStatus, 'discarded');

  return guarded(
    {
      actor, action: 'discard', resource: 'inquiry', resourceId: id,
      // The code reaches the auditor, prefixed so a discard and the purge that
      // eventually follows it are two distinguishable rows about one id.
      reason: `discarded:${reason}`,
      // Never the inquiry id: that column means *a client record*, and this is
      // not one (P0-6). It is also what lets a purged row leave its audit trail
      // standing with nothing dangling.
      clientId: undefined,
    },
    (tx) =>
      tx.inquiry.update({
        where: { id },
        data: {
          status: 'discarded',
          discardReason: reason,
          discardedAt: (opts.clock ?? systemClock).now(),
          // Where they went, on the one reason where that is a fact (P2).
          // Dropped on every other reason for the same argument `gpOnly` makes,
          // and refused outright by `inquiry_referred_out_has_a_reason`.
          referredOutToId: reason === 'referred_out' ? (opts.referredOutToId ?? null) : null,
        },
        select: SELECT,
      }),
  );
}

/**
 * ───────────────────────── the referral directory (P2) ─────────────────────
 *
 * `gp` and `referred_out` were codes. A code answers "how many came from a
 * GP"; it cannot answer "which surgery has stopped sending us anybody", and
 * that second question is the one a practice does something about.
 *
 * One table serves both directions on purpose: the surgery you refer an
 * eating-disorder case out to is the surgery that sends you their anxiety
 * referrals next month, and splitting it in two would hold that relationship
 * twice and let the halves drift.
 *
 * It holds no client and no clinical content, which is what makes it safe for
 * a report guarded on aggregates to name a row out loud — a surgery is the
 * practice's business relationship, not somebody's health.
 */

/** A contact the practice exchanges referrals with. */
export interface ReferrerInput {
  practice: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

const REFERRER_SELECT = {
  id: true, practice: true, name: true, phone: true, email: true, active: true,
} as const;

/**
 * The directory. Retired entries are included by default and marked, never
 * hidden: a report over last March has to be able to name a surgery that has
 * since closed its list, and a picker filters this list rather than asking for
 * a different one.
 */
export async function listReferrers(actor: Actor, opts: { activeOnly?: boolean } = {}) {
  return guarded(
    { actor, action: 'read', resource: 'referrer' },
    (tx) =>
      tx.referrer.findMany({
        where: opts.activeOnly ? { active: true } : {},
        select: REFERRER_SELECT,
        orderBy: [{ practice: 'asc' }, { name: 'asc' }],
      }),
  );
}

/**
 * Add one. Front desk hears "Dr Patel at Riverside" mid-call and needs it in
 * the list before the enquiry is saved, so the power sits with the people on
 * the phone rather than behind a practice-settings page.
 *
 * The anonymous form holds no cell here, deliberately: a public submitter
 * saying "my GP sent me" writes a code and nothing else, and somebody rings
 * back to find out which surgery. Letting the internet append to a directory
 * every future enquiry reads is not the same act as letting it leave a name
 * and a number.
 */
export async function createReferrer(actor: Actor, data: ReferrerInput) {
  return guarded(
    { actor, action: 'create', resource: 'referrer' },
    (tx) => tx.referrer.create({ data, select: REFERRER_SELECT }),
  );
}

/**
 * Retire one, or bring it back. Never a delete: enquiries point here, the
 * report reads them, and a surgery that stopped taking referrals in June is a
 * fact about June onwards — not a reason to rewrite what happened in March.
 * `onDelete: Restrict` on both relations says the same thing in the database.
 */
export async function setReferrerActive(actor: Actor, id: string, active: boolean) {
  return guarded(
    { actor, action: 'update', resource: 'referrer', resourceId: id },
    (tx) => tx.referrer.update({ where: { id }, data: { active }, select: REFERRER_SELECT }),
  );
}

/**
 * ─────────────────────── assignment and capacity (P2) ───────────────────────
 *
 * Two halves of one decision, held by two different people on purpose.
 *
 * Front desk decides where a call goes; the clinician says whether they can
 * take it. Neither overrides the other: assignment is `update` on `inquiry` —
 * a cell front desk and the practice manager already hold and clinicians
 * deliberately do not — and capacity is its own resource whose only writer is
 * the person it is about. So the signal cannot be talked into agreeing with
 * whoever wants the call placed.
 *
 * Both live here rather than in a staff module because the only reason either
 * exists is deciding where an enquiry goes, and the rule and the only writer
 * of the column it governs should not be two files apart.
 */

/**
 * Put a call in somebody's queue, or take it back out (`null`).
 *
 * Only an open inquiry: a converted one belongs to a client with a treating
 * clinician, and a discarded one is counting down to being destroyed. Both
 * refuse with the same `Conflict` a late transition raises — the status is not
 * changing here, so this is a guard on the row's state rather than a move
 * through the table above.
 *
 * A clinician who is not accepting is **not** refused. Somebody who rang and
 * asked for Alex by name still goes to Alex; the signal is what front desk
 * reads before deciding, and `no_capacity` is the honest ending when the answer
 * is really no. A hard block here would only teach people to flip the boolean.
 */
export async function assignInquiry(actor: Actor, id: string, clinicianId: string | null) {
  const row = await prisma.inquiry.findUnique({ where: { id }, select: { status: true } });
  if (!row) throw new NotFound('Inquiry');
  if (row.status !== 'open') {
    throw new Conflict(`A ${row.status} inquiry cannot be assigned`, 'bad_transition');
  }

  return guarded(
    { actor, action: 'update', resource: 'inquiry', resourceId: id },
    (tx) => tx.inquiry.update({ where: { id }, data: { assignedClinicianId: clinicianId }, select: SELECT }),
  );
}

/**
 * Every clinician, what they say, and what the rows say.
 *
 * `declared` is maintained by hand, by the clinician alone. `accepting` is what
 * front desk reads: the declared value, closed on any day of a leave (leave
 * P0-6, D-07). Nothing is written when a leave starts, so nothing has to be
 * restored when it ends, and nobody but the clinician gains `capacity.update`. `caseload` and `queued` are
 * measured off data that already exists, which is why neither has a column:
 * a number somebody has to remember to update is a number that is wrong by
 * Thursday, and a stale capacity figure is worse than none because front desk
 * would believe it.
 */
export async function clinicianCapacity(actor: Actor, clock: Clock = systemClock) {
  const today = localDateOf(clock.now());
  return guarded(
    { actor, action: 'read', resource: 'capacity' },
    async (tx) => {
      const clinicians = await tx.user.findMany({
        where: { active: true, role: { in: ['therapist', 'associate', 'supervisor'] } },
        select: {
          id: true, name: true, role: true, acceptingNewClients: true,
          // The one under way, when there is one: two live leaves never share a day.
          leaves: {
            where: { cancelledAt: null, toDate: { gte: new Date(`${today}T00:00:00Z`) } },
            orderBy: { fromDate: 'asc' }, take: 1,
            select: { fromDate: true, toDate: true },
          },
          _count: {
            select: {
              clients: { where: { status: 'active' } },
              inquiriesAssigned: { where: { status: 'open' } },
            },
          },
        },
        orderBy: { name: 'asc' },
      });

      return clinicians.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        accepting: c.acceptingNewClients && !c.leaves.some((l) => leavePhase({
          fromDate: l.fromDate.toISOString().slice(0, 10), toDate: l.toDate.toISOString().slice(0, 10),
        }, today) === 'active'),
        declared: c.acceptingNewClients,
        caseload: c._count.clients,
        queued: c._count.inquiriesAssigned,
      }));
    },
  );
}

/**
 * Say whether you can take somebody new. Yours alone — `self`, and the target
 * is what makes that decidable in the matrix rather than here.
 *
 * The id is taken from the actor and never from the caller. A parameter would
 * be a second way to name a subject, and the only thing it could ever express
 * is the case the matrix exists to refuse.
 */
export async function setCapacity(actor: Actor, accepting: boolean) {
  return guarded(
    {
      actor, action: 'update', resource: 'capacity', resourceId: actor.id,
      target: { subjectUserId: actor.id },
    },
    (tx) =>
      tx.user.update({
        where: { id: actor.id },
        data: { acceptingNewClients: accepting },
        select: { id: true, acceptingNewClients: true },
      }),
  );
}

/**
 * Conversion (P0-8). The one explicit act that captures what a first phone
 * call cannot: a date of birth, a treating clinician, and a code to file them
 * under. Everything the caller already told us is carried across.
 *
 * One transaction, two authorizations. Only front desk holds both — clinicians
 * and the practice manager have no `create` on `client` — so who may convert
 * falls out of the existing matrix with no new cell to review.
 *
 * The inquiry row is kept, now pointing at the client. It is what makes "how
 * long from call to first session" answerable, and it is why a converted
 * inquiry is unpurgeable: it is part of a client's history.
 *
 * Sending the intake packet is the caller's next step, never a hidden side
 * effect — `issueForm` refuses a template the client cannot read in their
 * language, and that refusal has to surface to the person who clicked rather
 * than get swallowed inside a conversion.
 */
export async function convertInquiry(
  actor: Actor,
  id: string,
  data: { code: string; dateOfBirth: Date; treatingClinicianId: string } & ClientEdit,
) {
  const row = await prisma.inquiry.findUnique({
    where: { id },
    select: {
      status: true, firstName: true, lastName: true, phone: true, email: true,
      referralSource: true, referralNote: true,
    },
  });
  if (!row) throw new NotFound('Inquiry');
  assertTransition(row.status as InquiryStatus, 'converted');

  // Decided here rather than by the column default, because both audit rows
  // below name it and a row that does not exist yet cannot be named. This is
  // the one place `clientId` on an inquiry-shaped audit row is not null: the
  // column means *a client record*, and from this transaction on there is one.
  const clientId = randomUUID();

  return guardedAll(
    [
      { actor, action: 'create' as const, resource: 'client' as const, resourceId: clientId, clientId },
      { actor, action: 'update' as const, resource: 'inquiry' as const, resourceId: id, clientId },
    ],
    async (tx) => {
      const client = await tx.client.create({
        data: {
          id: clientId,
          firstName: row.firstName,
          lastName: row.lastName,
          phone: row.phone,
          email: row.email,
          // The same fact, copied to the tier the business report reads. Not
          // synced with the intake form's answer, ever — that one is a
          // submission front desk may not open (D-04).
          referralSource: row.referralSource,
          referralNote: row.referralNote,
          ...data,
        },
        select: {
          id: true, code: true, firstName: true, lastName: true, dateOfBirth: true,
          phone: true, email: true, treatingClinicianId: true,
          referralSource: true, referralNote: true,
        },
      });

      await tx.inquiry.update({
        where: { id },
        data: { status: 'converted', clientId },
        select: { id: true },
      });

      // Repointed, not recreated: what they wanted — an hour the practice does
      // not have — did not change when they became a client. The XOR
      // constraint is why both columns move in one write.
      await tx.waitlistEntry.updateMany({
        where: { inquiryId: id },
        data: { clientId, inquiryId: null },
      });

      return client;
    },
  );
}

/**
 * Every reason ages out on the general window (P1-4) except the two with
 * their own clock (P2): `spam` was never a real caller, and `referred_out` is
 * a record of the practice having acted, not just a dead lead.
 */
const RETENTION_DAYS_FIELD: Partial<Record<DiscardReason, 'spamRetentionDays' | 'referredOutRetentionDays'>> = {
  spam: 'spamRetentionDays',
  referred_out: 'referredOutRetentionDays',
};

/** The candidate filter both the purge and its preview delete-or-read against. */
async function purgeWhere(clock: Clock) {
  const settings = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const general = settings?.inquiryRetentionDays ?? 90;
  const cutoff = (days: number) => new Date(clock.now().getTime() - days * DAY);

  const reasons = Object.keys(RETENTION_DAYS_FIELD) as DiscardReason[];
  return {
    status: 'discarded' as const,
    OR: [
      // Everything but the two reasons below, on the general window.
      { discardReason: { notIn: reasons }, discardedAt: { lte: cutoff(general) } },
      ...reasons.map((reason) => ({
        discardReason: reason,
        discardedAt: { lte: cutoff(settings?.[RETENTION_DAYS_FIELD[reason]!] ?? general) },
      })),
    ],
  };
}

/**
 * The purge (P0-5). Destroys discarded inquiries past the retention window.
 *
 * Two-step on purpose (D-03): an immediate hard delete makes a mis-click at 9am
 * unrecoverable when they ring back at 2pm, and a soft delete that never
 * completes is the thing this whole PRD exists to refuse.
 *
 * Idempotent by construction — a purged row is not in the next run's candidate
 * set because it is not anywhere. What survives is the audit row, whose
 * `resourceId` now names nothing. That is the correct end state (D-06): the log
 * says an inquiry was created, was handled, and was destroyed, and it never
 * said who it was.
 */
export async function runInquiryPurge(clock: Clock = systemClock): Promise<string[]> {
  // The public form's throttle rows age out here too. They are a side effect of
  // that form, hold nothing anybody needs once their hour has passed, and this
  // is already the sweep that destroys what the practice has no reason to keep
  // — a second schedule for one `deleteMany` would be a second thing to forget
  // to run. Inlined rather than imported from `public-inquiry.ts`, which
  // imports `createInquiry` from here.
  await prisma.inquiryThrottle.deleteMany({
    where: { windowStartedAt: { lte: new Date(clock.now().getTime() - HOUR) } },
  });

  const due = await prisma.inquiry.findMany({
    where: await purgeWhere(clock),
    select: { id: true },
  });

  for (const { id } of due) {
    await guarded(
      { actor: SYSTEM_ACTOR, action: 'discard', resource: 'inquiry', resourceId: id, reason: 'purged' },
      (tx) => tx.inquiry.delete({ where: { id } }),
    );
  }
  return due.map((d) => d.id);
}

/**
 * P1-4: what the next sweep would destroy, if it ran right now. Same candidate
 * query as `runInquiryPurge` with the delete swapped for a read, so the window
 * is visible before it fires rather than after.
 *
 * `read: always` on `inquiry` — the same cell `listInquiries` reads under.
 * A preview is not a new power over the row, only a different render of one
 * front desk and every clinician can already see.
 */
export async function previewInquiryPurge(actor: Actor, opts: { clock?: Clock } = {}) {
  const where = await purgeWhere(opts.clock ?? systemClock);

  return guarded(
    { actor, action: 'read', resource: 'inquiry' },
    (tx) =>
      tx.inquiry.findMany({
        where,
        select: { id: true, firstName: true, lastName: true, discardReason: true, discardedAt: true },
        orderBy: { discardedAt: 'asc' },
      }),
  );
}
