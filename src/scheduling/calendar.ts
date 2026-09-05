import { guarded } from '../auth/guard';
import { ownCaseloadOnly, type Actor } from '../auth/permissions';
import { prisma } from '../db';
import { NotFound } from '../errors';
import { addDays, localDateOf, zonedToUtc, type LocalDate } from '../time';
import { workingWindows, type Override } from './availability';

/**
 * The day, as front desk reads it: who is in which room at what time.
 *
 * Everything here is operational. Client names and times are the whole point —
 * you cannot run a waiting room without them — and nothing about *why* anyone
 * is here appears at any level of this surface.
 */
export async function daySchedule(actor: Actor, date: LocalDate) {
  const mineOnly = ownCaseloadOnly(actor);

  return guarded(
    { actor, action: 'read', resource: 'appointment' },
    async (tx) => {
      const [appointments, rooms, clinicians, overrides] = await Promise.all([
        tx.appointment.findMany({
          where: {
            startAt: { gte: zonedToUtc(date, 0), lt: zonedToUtc(addDays(date, 1), 0) },
            ...(mineOnly ? { clinicianId: actor.id } : {}),
          },
          select: {
            id: true, startAt: true, endAt: true, status: true, modality: true, type: true,
            roomId: true, clinicianId: true, seriesId: true, detached: true,
            groupSessionId: true,
            groupSession: { select: { topic: true } },
            client: { select: { id: true, code: true, firstName: true, lastName: true } },
            clinician: { select: { id: true, name: true } },
            room: { select: { id: true, name: true } },
          },
          // The id breaks ties, so two sessions in the same minute come back
          // in the same order every time. Without it the day view is free to
          // move between identical runs — which is a bug in a project whose
          // README screenshots are a spec.
          orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        }),
        tx.room.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
        tx.user.findMany({
          where: { active: true, role: { in: ['therapist', 'associate', 'supervisor'] }, ...(mineOnly ? { id: actor.id } : {}) },
          select: { id: true, name: true, role: true },
          orderBy: { name: 'asc' },
        }),
        tx.availabilityOverride.findMany({
          where: { fromDate: { lte: zonedToUtc(date, 0) }, toDate: { gte: zonedToUtc(date, 0) } },
          select: { userId: true, kind: true, fromDate: true, toDate: true, startMinute: true, endMinute: true, reason: true },
        }),
      ]);

      const minutesOf = (d: Date) => Math.round((d.getTime() - zonedToUtc(date, 0).getTime()) / 60_000);

      const away = new Set(
        overrides
          .filter((o) => {
            const asOverride: Override = {
              fromDate: localDateOf(o.fromDate), toDate: localDateOf(o.toDate),
              kind: o.kind, startMinute: o.startMinute ?? undefined, endMinute: o.endMinute ?? undefined,
            };
            return workingWindows([{ weekday: 0, startMinute: 0, endMinute: 1440 }], [asOverride], date).length === 0;
          })
          .map((o) => o.userId),
      );

      return {
        date,
        rooms,
        clinicians,
        away: [...away],
        awayReasons: Object.fromEntries(overrides.map((o) => [o.userId, o.reason ?? 'Unavailable'])),
        sessions: appointments.map((a) => ({
          ...a,
          startMinute: minutesOf(a.startAt),
          endMinute: minutesOf(a.endAt),
        })),
      };
    },
  );
}

type DaySchedule = Awaited<ReturnType<typeof daySchedule>>;
export type DaySession = DaySchedule['sessions'][number];

/** One session in full, with everything the detail screen needs. */
export async function getAppointment(actor: Actor, id: string) {
  const row = await prisma.appointment.findUnique({ where: { id }, select: { clientId: true } });
  if (!row) throw new NotFound('Appointment');

  return guarded(
    { actor, action: 'read', resource: 'appointment', resourceId: id, clientId: row.clientId },
    (tx) =>
      tx.appointment.findUniqueOrThrow({
        where: { id },
        include: {
          client: { select: { id: true, code: true, firstName: true, lastName: true, reminderPreference: true, feeCents: true } },
          clinician: { select: { id: true, name: true, role: true } },
          room: { select: { id: true, name: true } },
          series: { select: { id: true, frequency: true, weekday: true, startMinute: true } },
          progressNote: { select: { id: true, status: true, authorId: true } },
        },
      }),
  );
}
