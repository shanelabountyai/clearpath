import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { DAY, systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { Conflict, NotFound } from '../errors';
import { SYSTEM_ACTOR } from '../scheduling/reminders';

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
  note?: string | null;
}

const SELECT = {
  id: true, firstName: true, lastName: true, phone: true, email: true,
  requestedClinicianId: true, referralSource: true, referralNote: true, note: true,
  status: true, discardReason: true, discardedAt: true, takenById: true, createdAt: true,
} as const;

export async function createInquiry(actor: Actor, data: InquiryInput) {
  return guarded(
    { actor, action: 'create', resource: 'inquiry' },
    (tx) => tx.inquiry.create({ data: { ...data, takenById: actor.id }, select: SELECT }),
  );
}

/**
 * One access event, one audit row — the same argument `listClients` makes.
 *
 * No caseload filter: a clinician sees every open inquiry, including the ones
 * that asked for somebody else, because a six-person practice discusses its own
 * intake. That is a UI default rather than a permission, and the matrix says so
 * with `read: always`.
 */
export async function listInquiries(actor: Actor, opts: { status?: InquiryStatus } = {}) {
  return guarded(
    { actor, action: 'read', resource: 'inquiry' },
    (tx) =>
      tx.inquiry.findMany({
        where: opts.status ? { status: opts.status } : {},
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
    (tx) => tx.inquiry.update({ where: { id }, data, select: SELECT }),
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
  opts: { clock?: Clock } = {},
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
        data: { status: 'discarded', discardReason: reason, discardedAt: (opts.clock ?? systemClock).now() },
        select: SELECT,
      }),
  );
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
  const settings = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const days = settings?.inquiryRetentionDays ?? 90;
  const cutoff = new Date(clock.now().getTime() - days * DAY);

  const due = await prisma.inquiry.findMany({
    where: { status: 'discarded', discardedAt: { lte: cutoff } },
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
