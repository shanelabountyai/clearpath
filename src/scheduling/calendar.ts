import { guarded } from '../auth/guard';
import { ownCaseloadOnly, type Actor, type Target } from '../auth/permissions';
import { clientTarget } from '../clients/repository';
import { prisma } from '../db';
import { NotFound } from '../errors';
import { addDays, dbDate, dbDateOf, zonedToUtc, type LocalDate } from '../time';
import { isAway } from './availability';

/**
 * Who an appointment answers to: its client's record, and the clinician it is
 * booked with (K4-C1). Every by-id appointment read and write resolves this.
 */
export async function appointmentTarget(appt: { clientId: string; clinicianId: string }): Promise<Target> {
  return { ...(await clientTarget(appt.clientId)), sessionClinicianId: appt.clinicianId };
}

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
    // A clinician's day is the sessions booked with them, which the query below
    // filters to; the target states that, it does not widen it.
    { actor, action: 'read', resource: 'appointment', ...(mineOnly && { target: { sessionClinicianId: actor.id } }) },
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
          orderBy: { startAt: 'asc' },
        }),
        tx.room.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
        tx.user.findMany({
          where: { active: true, role: { in: ['therapist', 'associate', 'supervisor'] }, ...(mineOnly ? { id: actor.id } : {}) },
          select: { id: true, name: true, role: true },
          orderBy: { name: 'asc' },
        }),
        tx.availabilityOverride.findMany({
          where: { fromDate: { lte: dbDate(date) }, toDate: { gte: dbDate(date) } },
          select: { userId: true, kind: true, fromDate: true, toDate: true, startMinute: true, endMinute: true, reason: true },
        }),
      ]);

      const minutesOf = (d: Date) => Math.round((d.getTime() - zonedToUtc(date, 0).getTime()) / 60_000);

      // Away means the whole day off. Extra hours or an afternoon off still
      // leave the clinician on the schedule.
      const away = new Set(
        overrides
          .filter((o) => isAway([{
            fromDate: dbDateOf(o.fromDate), toDate: dbDateOf(o.toDate),
            kind: o.kind, startMinute: o.startMinute ?? undefined, endMinute: o.endMinute ?? undefined,
          }], date))
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
  const row = await prisma.appointment.findUnique({ where: { id }, select: { clientId: true, clinicianId: true } });
  if (!row) throw new NotFound('Appointment');

  return guarded(
    { actor, action: 'read', resource: 'appointment', resourceId: id, clientId: row.clientId, target: await appointmentTarget(row) },
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
