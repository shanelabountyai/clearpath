import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { clientTarget } from '../clients/repository';
import { Conflict, NotFound } from '../errors';
import type { Confirmation } from './confirmation';

export type Status =
  | 'scheduled' | 'confirmed' | 'arrived' | 'in_session'
  | 'completed' | 'no_show' | 'cancelled' | 'late_cancelled';

/**
 * The session lifecycle, in one place.
 *
 * Terminal states are terminal: a completed session is not re-opened and a
 * cancellation is not un-cancelled, because both carry money and both are
 * already in the audit log. The correction for a wrong status is a new
 * appointment, the same way the correction for a signed note is an amendment.
 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'late_cancelled', 'no_show'],
  confirmed: ['arrived', 'cancelled', 'late_cancelled', 'no_show'],
  arrived: ['in_session', 'no_show'],
  in_session: ['completed'],
  completed: [],
  no_show: [],
  cancelled: [],
  late_cancelled: [],
};

export const canTransition = (from: Status, to: Status): boolean =>
  TRANSITIONS[from].includes(to);

/** Statuses that count against a client's attendance record. */
export const CHARGEABLE: readonly Status[] = ['no_show', 'late_cancelled'];

/**
 * Late or advance, decided from the clock rather than from whoever clicks.
 *
 * This is the practice's revenue-survival policy, so the person cancelling does
 * not get to characterise their own cancellation — a front-desk button labelled
 * "waive fee" is a management decision, not a data-entry one.
 */
export function classifyCancellation(
  startAt: Date,
  now: Date,
  windowHours: number,
): 'cancelled' | 'late_cancelled' {
  const noticeMs = startAt.getTime() - now.getTime();
  return noticeMs < windowHours * 3_600_000 ? 'late_cancelled' : 'cancelled';
}

async function loadSettings() {
  return (
    (await prisma.practiceSettings.findUnique({ where: { id: 1 } })) ?? {
      id: 1, name: 'Stillwater Counseling', standardFeeCents: 18000,
      lateCancelWindowHours: 24, lateCancelFeeCents: 9000,
      // Same figure as the late-cancel fee, which is the schema default too:
      // the field exists so a practice can raise it, not so it starts higher.
      noShowFeeCents: 9000,
      recurrenceHorizonDays: 90, continuityGapDays: 21,
    }
  );
}

/** Move a session along its lifecycle. Fees are derived, never supplied. */
export async function setStatus(
  actor: Actor,
  appointmentId: string,
  to: Status,
  opts: { reason?: string; clock?: Clock; confirmation?: Confirmation } = {},
) {
  const clock = opts.clock ?? systemClock;
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) throw new NotFound('Appointment');

  const from = appt.status as Status;
  if (!canTransition(from, to)) {
    throw new Conflict(`A ${from} session cannot become ${to}`, 'bad_transition');
  }

  const settings = await loadSettings();
  const now = clock.now();

  const data: Record<string, unknown> = { status: to };
  if (to === 'cancelled' || to === 'late_cancelled') {
    data.cancelledAt = now;
    data.cancelledById = actor.id;
    data.cancelReason = opts.reason ?? null;
  }
  // Two policies, not one. A practice charging half for a cancellation with
  // some notice and the full hour for an empty room is ordinary, and the
  // fields ship at the same figure so the split changed nothing on the day it
  // landed. Which of them applies is decided by the fact — not by whether a
  // person or the non-response sweep noticed it.
  if (to === 'late_cancelled') data.chargeFeeCents = settings.lateCancelFeeCents;
  if (to === 'no_show') data.chargeFeeCents = settings.noShowFeeCents;
  if (to === 'completed') {
    const client = await prisma.client.findUnique({ where: { id: appt.clientId }, select: { feeCents: true } });
    data.chargeFeeCents = client?.feeCents ?? settings.standardFeeCents;
  }
  // The client's door declines through here, so the answer and the cancellation
  // it causes land in one write with one audit row. Nothing else passes it: a
  // status write never infers a confirmation, which is the whole of D-02.
  if (opts.confirmation) data.confirmation = opts.confirmation;

  return guarded(
    {
      actor, action: 'update', resource: 'appointment',
      resourceId: appointmentId, clientId: appt.clientId,
      // Whose row this is. Staff roles decide on `always` and ignore it; it is
      // what lets the token door reach one appointment and no other.
      target: { ownerClientId: appt.clientId },
      // The answer is the reason code, which is why the log can be read for
      // "what determined this" without carrying a word anybody typed. The
      // operational `opts.reason` deliberately does not go here: it is free
      // text from a staff member, and free text in the audit log is one
      // distracted afternoon away from clinical content.
      reason: opts.confirmation,
    },
    (tx) => tx.appointment.update({ where: { id: appointmentId }, data }),
  );
}

/**
 * Cancel, letting the server decide whether it was late. The caller does not
 * get to pass the answer in.
 */
export async function cancelAppointment(
  actor: Actor,
  appointmentId: string,
  opts: { reason?: string; clock?: Clock; confirmation?: Confirmation } = {},
) {
  const clock = opts.clock ?? systemClock;
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) throw new NotFound('Appointment');

  const settings = await loadSettings();
  const to = classifyCancellation(appt.startAt, clock.now(), settings.lateCancelWindowHours);
  return setStatus(actor, appointmentId, to, opts);
}

/**
 * The four reasons a practice waives a fee. A fixed list, not a text box.
 *
 * Same discipline as the portal's reschedule reasons: a free-text field on a
 * money decision collects explanations nobody reads and, sooner or later, a
 * sentence about why the client was struggling — clinical content on an
 * operational surface, which is hard rule 3.
 */
export type FeeWaiveReason = 'practice_error' | 'client_disputed' | 'emergency' | 'goodwill';

/**
 * Undo a charge. The practice manager's decision and nobody else's.
 *
 * An automatic charge without a reversal is not shippable, which is why this
 * ships in the same phase as the sweep rather than after it. Two things make
 * the reversal honest rather than cosmetic:
 *
 *   - The flag goes to zero, so every total that already sums `chargeFeeCents`
 *     is right with no change to any of them.
 *   - What was charged goes into the audit row, so the amount is recoverable
 *     from the trail rather than overwritten out of existence. The reason is a
 *     code from a fixed list, and the row carries nothing else.
 *
 * It does not touch `status` or `confirmation`. The client still did not turn
 * up; the practice chose not to charge for it, and those are two facts.
 */
export async function waiveFee(
  actor: Actor,
  appointmentId: string,
  reason: FeeWaiveReason,
  opts: { clock?: Clock } = {},
) {
  const clock = opts.clock ?? systemClock;
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) throw new NotFound('Appointment');

  // Waiving nothing would leave a decision on the record that never happened,
  // and waiving twice would leave two. Both refuse rather than no-op, because
  // the trail is the product here.
  if (appt.chargeFeeCents === null) {
    throw new Conflict('That session carries no fee to waive', 'no_fee');
  }
  if (appt.feeWaivedAt !== null) {
    throw new Conflict('That fee has already been waived', 'already_waived');
  }

  return guarded(
    {
      actor, action: 'waive', resource: 'fee',
      resourceId: appointmentId, clientId: appt.clientId,
      // The figure and the code, which is what "recoverable from the audit
      // trail" means. Money is operational; a name or an answer would not be.
      reason: `${reason}; waived ${appt.chargeFeeCents} cents`,
    },
    (tx) =>
      tx.appointment.update({
        where: { id: appointmentId },
        data: {
          chargeFeeCents: 0,
          feeWaivedById: actor.id,
          feeWaivedAt: clock.now(),
          feeWaiveReason: reason,
        },
      }),
  );
}

/**
 * Attendance record. Visible to the client's clinician and to the practice
 * manager; front desk is denied, because a no-show count is a clinical-adjacent
 * pattern rather than a scheduling fact.
 */
export async function attendanceSummary(actor: Actor, clientId: string) {
  const target = await clientTarget(clientId);

  return guarded(
    { actor, action: 'read', resource: 'attendance_history', target, clientId },
    async (tx) => {
      const rows = await tx.appointment.groupBy({
        by: ['status'],
        where: { clientId },
        _count: { _all: true },
        _sum: { chargeFeeCents: true },
      });
      const count = (s: Status) => rows.find((r) => r.status === s)?._count._all ?? 0;
      return {
        completed: count('completed'),
        noShow: count('no_show'),
        lateCancelled: count('late_cancelled'),
        cancelled: count('cancelled'),
        chargeableFeeCents: rows
          .filter((r) => CHARGEABLE.includes(r.status as Status))
          .reduce((sum, r) => sum + (r._sum.chargeFeeCents ?? 0), 0),
      };
    },
  );
}
