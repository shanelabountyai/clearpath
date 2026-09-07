import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { clientTarget } from '../clients/repository';
import { Conflict, NotFound } from '../errors';
import type { Confirmation } from './confirmation';

/** A category the practice reports on, never free text on a money reversal. */
export type FeeWaiveReason = 'practice_error' | 'client_disputed' | 'emergency' | 'goodwill';

/**
 * Why a client declined, as one of the portal's four existing codes.
 *
 * Deliberately the same vocabulary as a reschedule request rather than a
 * parallel one: "I cannot make this time" is the same sentence whether the
 * client then asks for another slot or simply gives the hour back, and two
 * lists would drift. Optional everywhere, because the keyword decline can
 * never carry one.
 */
export type DeclineReason =
  | 'cannot_make_it' | 'need_a_different_time' | 'prefer_earlier' | 'prefer_later';

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
      recurrenceHorizonDays: 90, continuityGapDays: 21,
      // Ships at the late-cancel figure, so the field changes nothing the day
      // it lands and the policy change stays reviewable on its own (D-09).
      noShowFeeCents: 9000,
    }
  );
}

/** Move a session along its lifecycle. Fees are derived, never supplied. */
export async function setStatus(
  actor: Actor,
  appointmentId: string,
  to: Status,
  opts: {
    reason?: string;
    clock?: Clock;
    confirmation?: Confirmation;
    /** The client's own code for saying no. Only ever set beside `declined`. */
    declineReason?: DeclineReason;
    /**
     * A reason CODE for the audit row. Deliberately not `reason`, which is
     * operational free text a person typed: the audit log is read by the one
     * role that may not open a record, so only codes go in it.
     */
    auditReason?: string;
  } = {},
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
  // Two policies, two fields. A practice charging 50% for a late cancel and
  // 100% for a no-show is ordinary, and one field could not say both.
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
  // Rides the same write as the decline it explains, so there is no window in
  // which the practice has the answer but not the reason for it.
  if (opts.declineReason) data.declineReason = opts.declineReason;

  return guarded(
    {
      actor, action: 'update', resource: 'appointment',
      resourceId: appointmentId, clientId: appt.clientId,
      ...(opts.auditReason ? { reason: opts.auditReason } : {}),
      // Whose row this is. Staff roles decide on `always` and ignore it; it is
      // what lets the token door reach one appointment and no other.
      target: { ownerClientId: appt.clientId },
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
  opts: {
    reason?: string;
    clock?: Clock;
    confirmation?: Confirmation;
    declineReason?: DeclineReason;
  } = {},
) {
  const clock = opts.clock ?? systemClock;
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) throw new NotFound('Appointment');

  const settings = await loadSettings();
  const to = classifyCancellation(appt.startAt, clock.now(), settings.lateCancelWindowHours);
  return setStatus(actor, appointmentId, to, opts);
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

/**
 * Reverse a fee the practice decided to charge. Practice manager only.
 *
 * An automatic charge without a reversal is not shippable — the sweep can now
 * bill a client nobody spoke to, so somebody has to be able to undo it, and
 * the person who can is not the person who took the phone call. Front desk is
 * denied here and the denial is on the record, which is what turns the comment
 * on `classifyCancellation` from an intention into a rule.
 *
 * `status` and `confirmation` are deliberately untouched. The client still did
 * not turn up; the practice chose not to charge for it, and the record should
 * say both. The original amount rides in the audit row's reason code rather
 * than being overwritten out of existence — that row is append-only, so the
 * waiver cannot erase what it reversed.
 */
export async function waiveFee(
  actor: Actor,
  appointmentId: string,
  reason: FeeWaiveReason,
  opts: { clock?: Clock } = {},
) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) throw new NotFound('Appointment');
  if (appt.chargeFeeCents === null) throw new Conflict('There is no fee to waive', 'no_fee');
  if (appt.feeWaivedAt) throw new Conflict('That fee is already waived', 'already_waived');

  return guarded(
    {
      actor, action: 'waive', resource: 'fee',
      resourceId: appointmentId, clientId: appt.clientId,
      // Ids and integer cents. A waiver reason is a category, so the log stays
      // readable by the auditor without disclosing anything about the person.
      reason: `${reason}:${appt.chargeFeeCents}`,
    },
    (tx) =>
      tx.appointment.update({
        where: { id: appointmentId },
        data: {
          chargeFeeCents: 0,
          feeWaivedById: actor.id,
          feeWaivedAt: (opts.clock ?? systemClock).now(),
          feeWaiveReason: reason,
        },
      }),
  );
}
