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
