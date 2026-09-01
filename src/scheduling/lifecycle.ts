import { guarded } from '../auth/guard.js';
import type { Actor } from '../auth/permissions.js';
import { systemClock, type Clock } from '../clock.js';
import { prisma } from '../db.js';
import { Conflict, NotFound } from '../errors.js';

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
    }
  );
}

/** Move a session along its lifecycle. Fees are derived, never supplied. */
export async function setStatus(
  actor: Actor,
  appointmentId: string,
  to: Status,
  opts: { reason?: string; clock?: Clock } = {},
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
  if (to === 'late_cancelled' || to === 'no_show') {
    data.chargeFeeCents = settings.lateCancelFeeCents;
  }
  if (to === 'completed') {
    const client = await prisma.client.findUnique({ where: { id: appt.clientId }, select: { feeCents: true } });
    data.chargeFeeCents = client?.feeCents ?? settings.standardFeeCents;
  }

  return guarded(
    { actor, action: 'update', resource: 'appointment', resourceId: appointmentId, clientId: appt.clientId },
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
  opts: { reason?: string; clock?: Clock } = {},
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
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { treatingClinicianId: true },
  });
  if (!client) throw new NotFound('Client');

  return guarded(
    {
      actor, action: 'read', resource: 'attendance_history',
      target: { clinicianId: client.treatingClinicianId },
      clientId,
    },
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
