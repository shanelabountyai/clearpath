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

/**
 * How the confirmation loop actually performed — per clinician and practice-wide.
 *
 * It reads under `attendance_history`, the same cell as the utilisation report
 * beside it, and that is the decision worth stating. A confirmation *rate* on
 * its own is operational, and front desk could defensibly see one. This is not
 * that: it is a per-clinician breakdown of who is silent on whose caseload,
 * carrying the fee total the policy generated. Naming the loosest thing in the
 * payload would have been the wrong instinct — the guard belongs on the
 * strictest, and per-clinician attendance patterns plus money is exactly what
 * `attendance_history` exists to keep away from the front desk.
 *
 * The rate is `confirmed / decided`, never `confirmed / booked`. Dividing by
 * everything would mix in the hours the practice never asked about — a
 * `reminderPreference: 'none'` client would drag a clinician's number down for
 * a safety setting, which is the same category error the fee rule spent P0
 * avoiding.
 */
export async function confirmationReport(
  actor: Actor,
  range: { from: LocalDate; to: LocalDate },
) {
  return guarded(
    { actor, action: 'read', resource: 'attendance_history' },
    async (tx) => {
      const rows = await tx.appointment.findMany({
        where: {
          startAt: {
            gte: zonedToUtc(range.from, 0),
            lt: zonedToUtc(addDays(range.to, 1), 0),
          },
        },
        select: {
          clinicianId: true, confirmation: true, status: true,
          chargeFeeCents: true, declineReason: true,
          clinician: { select: { name: true } },
        },
      });

      const blank = () => ({
        notRequired: 0, pending: 0, confirmed: 0, declined: 0, noResponse: 0,
        /**
         * Money this policy and no other produced: silence that became a
         * no-show charge. A late cancel is charged whether or not anyone was
         * ever asked to confirm, so counting it here would credit the loop
         * with revenue it did not cause. A waiver zeroes `chargeFeeCents`, so
         * a reversed fee falls out of the sum without a second condition.
         */
        feeCents: 0,
      });

      const totals = blank();
      const byClinician = new Map<string, { id: string; name: string } & ReturnType<typeof blank>>();
      const byReason = new Map<string, number>();

      for (const r of rows) {
        const row = byClinician.get(r.clinicianId)
          ?? { id: r.clinicianId, name: r.clinician.name, ...blank() };

        for (const t of [row, totals]) {
          if (r.confirmation === 'not_required') t.notRequired++;
          if (r.confirmation === 'pending') t.pending++;
          if (r.confirmation === 'confirmed') t.confirmed++;
          if (r.confirmation === 'declined') t.declined++;
          if (r.confirmation === 'no_response') {
            t.noResponse++;
            if (r.status === 'no_show') t.feeCents += r.chargeFeeCents ?? 0;
          }
        }
        // Practice-wide only. Which clinician a client gave "prefer_earlier" to
        // says something about a timetable, not about a clinician.
        if (r.confirmation === 'declined' && r.declineReason) {
          byReason.set(r.declineReason, (byReason.get(r.declineReason) ?? 0) + 1);
        }
        byClinician.set(r.clinicianId, row);
      }

      return {
        range,
        totals: { ...totals, rate: confirmationRate(totals) },
        clinicians: [...byClinician.values()]
          .map((c) => ({ ...c, rate: confirmationRate(c) }))
          .sort((a, b) => b.rate - a.rate || a.name.localeCompare(b.name)),
        /**
         * Null reasons are absent by construction, not counted as a category.
         * "Did not say" is most declines — the portal asks without requiring an
         * answer and a keyword decline cannot carry one — and a bar labelled
         * with it would swamp the four that mean something.
         */
        declineReasons: [...byReason.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      };
    },
  );
}

/** Answered out of asked-and-settled. `pending` is still in flight, not a miss. */
const confirmationRate = (t: { confirmed: number; declined: number; noResponse: number }) =>
  rate(t.confirmed, t.confirmed + t.declined + t.noResponse);
