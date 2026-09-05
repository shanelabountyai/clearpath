import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { addDays, localDateOf, zonedToUtc, type LocalDate } from '../time';

/**
 * Practice-level numbers, for the person who runs the practice. Counts and
 * rates only — no client is named and no session content is reachable from
 * here, so the report says how full the rooms were without saying who was in
 * them.
 */
export async function utilizationReport(
  actor: Actor,
  range: { from: LocalDate; to: LocalDate },
) {
  return guarded(
    { actor, action: 'read', resource: 'attendance_history' },
    async (tx) => {
      const start = zonedToUtc(range.from, 0);
      const end = zonedToUtc(addDays(range.to, 1), 0);

      const appointments = await tx.appointment.findMany({
        where: { startAt: { gte: start, lt: end } },
        select: {
          id: true, clinicianId: true, roomId: true, startAt: true, endAt: true,
          status: true, modality: true,
          clinician: { select: { id: true, name: true, role: true } },
          room: { select: { id: true, name: true } },
        },
      });

      const rooms = await tx.room.findMany({ where: { active: true }, select: { id: true, name: true } });

      const byClinician = new Map<string, {
        id: string; name: string; role: string;
        booked: number; completed: number; noShow: number; lateCancelled: number;
        cancelled: number; telehealth: number; minutes: number;
      }>();

      for (const a of appointments) {
        const row = byClinician.get(a.clinicianId) ?? {
          id: a.clinicianId, name: a.clinician.name, role: a.clinician.role,
          booked: 0, completed: 0, noShow: 0, lateCancelled: 0, cancelled: 0, telehealth: 0, minutes: 0,
        };
        row.booked++;
        if (a.status === 'completed') {
          row.completed++;
          row.minutes += (a.endAt.getTime() - a.startAt.getTime()) / 60_000;
        }
        if (a.status === 'no_show') row.noShow++;
        if (a.status === 'late_cancelled') row.lateCancelled++;
        if (a.status === 'cancelled') row.cancelled++;
        if (a.modality === 'telehealth') row.telehealth++;
        byClinician.set(a.clinicianId, row);
      }

      const held = appointments.filter((a) => !['cancelled', 'late_cancelled'].includes(a.status));
      const roomMinutes = new Map<string, number>();
      for (const a of held) {
        if (!a.roomId) continue;
        roomMinutes.set(a.roomId, (roomMinutes.get(a.roomId) ?? 0) + (a.endAt.getTime() - a.startAt.getTime()) / 60_000);
      }

      // Capacity is the practice's own working day, not 24 hours: an 8-hour day
      // over the weekdays in range. A percentage against midnight-to-midnight
      // would make a full practice look half empty.
      const weekdaysInRange = countWeekdays(range.from, range.to);
      const capacityPerRoom = weekdaysInRange * 8 * 60;

      const totals = {
        booked: appointments.length,
        completed: appointments.filter((a) => a.status === 'completed').length,
        noShow: appointments.filter((a) => a.status === 'no_show').length,
        lateCancelled: appointments.filter((a) => a.status === 'late_cancelled').length,
        cancelled: appointments.filter((a) => a.status === 'cancelled').length,
        telehealth: appointments.filter((a) => a.modality === 'telehealth').length,
      };

      return {
        range,
        totals,
        rates: {
          noShow: rate(totals.noShow, totals.booked),
          lateCancel: rate(totals.lateCancelled, totals.booked),
          telehealth: rate(totals.telehealth, totals.booked),
        },
        clinicians: [...byClinician.values()].sort((a, b) => b.completed - a.completed),
        rooms: rooms.map((r) => ({
          id: r.id,
          name: r.name,
          bookedMinutes: roomMinutes.get(r.id) ?? 0,
          capacityMinutes: capacityPerRoom,
          utilization: capacityPerRoom ? round2((roomMinutes.get(r.id) ?? 0) / capacityPerRoom) : 0,
        })),
      };
    },
  );
}

const rate = (n: number, of: number) => (of === 0 ? 0 : round2(n / of));
const round2 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * P1-4. What the confirmation policy actually did, per clinician and across the
 * practice.
 *
 * The counts are the point, and so is the last column. A practice that turns on
 * an automatic fee should be able to see, in one place and without asking
 * anybody, how many sessions it charged for and how much that came to — because
 * the argument against this policy (Risk 1: non-response in counseling
 * correlates with the reason people attend) is answerable only from data, and a
 * number nobody can find is a number nobody will check.
 *
 * `notRequired` is a column rather than a footnote for the same reason. It is
 * the count of sessions the practice was never allowed to charge for, and a
 * report that hid it would make the exemption invisible in exactly the place
 * somebody is deciding whether the policy is working.
 */
export async function confirmationReport(
  actor: Actor,
  range: { from: LocalDate; to: LocalDate },
) {
  return guarded(
    { actor, action: 'read', resource: 'attendance_history' },
    async (tx) => {
      const appointments = await tx.appointment.findMany({
        where: {
          startAt: { gte: zonedToUtc(range.from, 0), lt: zonedToUtc(addDays(range.to, 1), 0) },
        },
        select: {
          clinicianId: true, confirmation: true, status: true, chargeFeeCents: true,
          feeWaivedAt: true,
          clinician: { select: { id: true, name: true, role: true } },
        },
      });

      const blank = () => ({
        confirmed: 0, declined: 0, noResponse: 0, notRequired: 0, pending: 0,
        /** Sessions this policy charged for: silent, absent, and not waived. */
        charged: 0, feeCents: 0, waived: 0,
      });
      type Row = ReturnType<typeof blank> & { id: string; name: string; role: string };

      const byClinician = new Map<string, Row>();
      const totals = blank();

      for (const a of appointments) {
        const row = byClinician.get(a.clinicianId)
          ?? { id: a.clinicianId, name: a.clinician.name, role: a.clinician.role, ...blank() };

        const bucket = {
          confirmed: 'confirmed', declined: 'declined',
          no_response: 'noResponse', not_required: 'notRequired', pending: 'pending',
        }[a.confirmation] as keyof ReturnType<typeof blank>;
        row[bucket]++;
        totals[bucket]++;

        // The fee this feature produced, and only that one: a no-show somebody
        // marked by hand is the practice's ordinary policy and is already in
        // the utilization report.
        if (a.confirmation === 'no_response' && a.status === 'no_show') {
          if (a.feeWaivedAt) {
            row.waived++;
            totals.waived++;
          } else {
            row.charged++;
            totals.charged++;
            row.feeCents += a.chargeFeeCents ?? 0;
            totals.feeCents += a.chargeFeeCents ?? 0;
          }
        }
        byClinician.set(a.clinicianId, row);
      }

      // Sessions the practice was allowed to ask about. Every rate below is
      // against this rather than against everything booked, because a client on
      // "no messages" was never in the denominator of a question nobody put.
      const asked = totals.confirmed + totals.declined + totals.noResponse + totals.pending;

      // P2. What the carrier did with the messages this policy sent, in the
      // same range and on the same page as the money the policy produced.
      //
      // It is here rather than on a page of its own because of what it is for:
      // the fee's precondition is now a delivery receipt, so a practice
      // defending the charge needs the delivery rate in the same glance as the
      // charge rate. A high `failed` count is not a messaging problem to look
      // at later — it is the reason the charged number is lower than somebody
      // expected, and it is a list of clients nobody is reaching.
      const delivery = await tx.outboxMessage.groupBy({
        by: ['deliveryState'],
        where: {
          templateKey: 'appointment_reminder',
          scheduledFor: { gte: zonedToUtc(range.from, 0), lt: zonedToUtc(addDays(range.to, 1), 0) },
        },
        _count: { _all: true },
      });
      const count = (state: string) =>
        delivery.find((d) => d.deliveryState === state)?._count._all ?? 0;
      const messages = {
        delivered: count('delivered'),
        failed: count('failed'),
        /** Accepted by a carrier and not yet spoken for. Not evidence of anything. */
        awaiting: count('sent'),
        queued: count('queued'),
      };
      const handed = messages.delivered + messages.failed + messages.awaiting;

      // P2-3. Sessions the practice reached, but too late for reaching them to
      // count. Beside the delivery rate rather than on a page of its own, and
      // for the same reason: both are preconditions of the charge, so a manager
      // reading "we charged 31" needs "and stood down on 17 more" without
      // changing page.
      //
      // It reads differently from the undelivered count, though, and that is
      // why it is its own number. An undelivered message is an address problem
      // with a phone call behind it. This one is a *settings* problem: a cadence
      // whose only message keeps landing inside the answering window is a
      // cadence that cannot support the fee, and the practice should see that
      // as a count rather than as a slow drift in the charge rate.
      const reachedTooLate = await tx.auditEvent.count({
        where: {
          reason: 'confirmation_unanswerable',
          at: { gte: zonedToUtc(range.from, 0), lt: zonedToUtc(addDays(range.to, 1), 0) },
        },
      });

      return {
        reachedTooLate,
        range,
        totals,
        asked,
        messages: {
          ...messages,
          /** Of everything a carrier took. Queued rows have not been tried yet. */
          deliveredRate: handed ? messages.delivered / handed : 0,
        },
        rates: {
          confirmed: asked ? totals.confirmed / asked : 0,
          declined: asked ? totals.declined / asked : 0,
          noResponse: asked ? totals.noResponse / asked : 0,
          /** Of everything booked — the share the policy could never touch. */
          notRequired: appointments.length ? totals.notRequired / appointments.length : 0,
          charged: asked ? totals.charged / asked : 0,
        },
        byClinician: [...byClinician.values()].sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  );
}

function countWeekdays(from: LocalDate, to: LocalDate): number {
  let count = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

/** Sessions per clinician per calendar week — the shape a manager actually reads. */
export async function weeklyVolume(actor: Actor, range: { from: LocalDate; to: LocalDate }) {
  return guarded(
    { actor, action: 'read', resource: 'attendance_history' },
    async (tx) => {
      const rows = await tx.appointment.findMany({
        where: {
          startAt: { gte: zonedToUtc(range.from, 0), lt: zonedToUtc(addDays(range.to, 1), 0) },
          status: 'completed',
        },
        select: { startAt: true, clinicianId: true, clinician: { select: { name: true } } },
      });

      const buckets = new Map<string, { week: LocalDate; clinicianId: string; name: string; sessions: number }>();
      for (const r of rows) {
        const week = weekStart(localDateOf(r.startAt));
        const key = `${week}:${r.clinicianId}`;
        const bucket = buckets.get(key) ?? { week, clinicianId: r.clinicianId, name: r.clinician.name, sessions: 0 };
        bucket.sessions++;
        buckets.set(key, bucket);
      }
      return [...buckets.values()].sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name));
    },
  );
}

/** The Monday of the week a date falls in. */
export function weekStart(date: LocalDate): LocalDate {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, weekday === 0 ? -6 : 1 - weekday);
}
