import { guarded } from '../auth/guard';
import { ownCaseloadOnly, type Actor } from '../auth/permissions';
import { prisma } from '../db';
import { NotFound } from '../errors';
import { addDays, calendarDateOf, zonedToUtc, type LocalDate } from '../time';
import { lostWindows, workingWindows, type Override, type Span } from './availability';

/** Roles that hold a caseload, and therefore a column on the day view. */
const CLINICAL_ROLES = ['therapist', 'associate', 'supervisor'] as const;

/**
 * The day, as front desk reads it: who is in which room at what time.
 *
 * Everything here is operational. Client names and times are the whole point —
 * you cannot run a waiting room without them — and nothing about *why* anyone
 * is here appears at any level of this surface.
 */
export async function daySchedule(actor: Actor, date: LocalDate) {
  const mineOnly = ownCaseloadOnly(actor);

  // One definition of "the clinicians on this screen", shared by the three
  // queries that must agree about it. Narrowing the two supporting queries is
  // data minimisation rather than the fix for anything: `absencesOn` walks the
  // clinician list, so an override belonging to somebody off-screen could not
  // reach the output either way, and a mutant that drops this line survives
  // the suite. It stays because a therapist reading their own day has no
  // business pulling the whole practice's absence reasons into the request.
  const onScreen = {
    active: true,
    role: { in: [...CLINICAL_ROLES] },
    ...(mineOnly ? { id: actor.id } : {}),
  };

  return guarded(
    { actor, action: 'read', resource: 'appointment' },
    async (tx) => {
      const [appointments, rooms, clinicians, overrides, weekly] = await Promise.all([
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
          where: onScreen,
          select: { id: true, name: true, role: true },
          orderBy: { name: 'asc' },
        }),
        tx.availabilityOverride.findMany({
          where: {
            user: onScreen,
            fromDate: { lte: dateColumn(date) },
            toDate: { gte: dateColumn(date) },
          },
          select: { userId: true, kind: true, fromDate: true, toDate: true, startMinute: true, endMinute: true, reason: true },
          orderBy: { fromDate: 'asc' },
        }),
        tx.availability.findMany({
          where: { user: onScreen },
          select: { userId: true, weekday: true, startMinute: true, endMinute: true },
        }),
      ]);

      const midnight = zonedToUtc(date, 0).getTime();
      const minutesOf = (d: Date) => Math.round((d.getTime() - midnight) / 60_000);

      return {
        date,
        rooms,
        clinicians,
        absences: absencesOn(clinicians, overrides, weekly, date),
        sessions: appointments.map((a) => ({
          ...a,
          startMinute: minutesOf(a.startAt),
          endMinute: minutesOf(a.endAt),
        })),
      };
    },
  );
}

/** A `@db.Date` bound. The column holds a calendar date, so midnight UTC is it. */
const dateColumn = (date: LocalDate) => new Date(`${date}T00:00:00Z`);

type OverrideRow = {
  userId: string;
  kind: Override['kind'];
  fromDate: Date;
  toDate: Date;
  startMinute: number | null;
  endMinute: number | null;
  reason: string | null;
};

export interface Absence {
  userId: string;
  /** Operational, never clinical — it is shown to front desk. */
  reason: string;
  /** True only when the override takes the whole of the day they would work. */
  allDay: boolean;
  /** The working time the override removes. Never empty. */
  lost: Span[];
}

/**
 * Who is out today, and for how much of it.
 *
 * The old answer to this was a single `away` list built by subtracting each
 * override from a synthetic all-day window pinned to `weekday: 0`. Six days a
 * week that base window filtered itself away to nothing, so *any* override —
 * two hours at the dentist — subtracted to an empty day and read as away. The
 * banner said a clinician was gone while their afternoon sat in the grid
 * underneath it. Against the real pattern the two cases separate, which is the
 * distinction front desk needs: one of them is a set of phone calls and the
 * other is a note.
 */
function absencesOn(
  clinicians: { id: string }[],
  overrides: OverrideRow[],
  weekly: { userId: string; weekday: number; startMinute: number; endMinute: number }[],
  date: LocalDate,
): Absence[] {
  return clinicians.flatMap((c) => {
    const theirs = overrides.filter((o) => o.userId === c.id).map(asOverride);
    if (theirs.length === 0) return [];

    const pattern = weekly.filter((w) => w.userId === c.id);
    const lost = lostWindows(pattern, theirs, date);
    if (lost.length === 0) return [];

    const reasons = [
      ...new Set(
        overrides
          .filter((o) => o.userId === c.id && o.kind === 'unavailable' && o.reason)
          .map((o) => o.reason as string),
      ),
    ];
    return [{
      userId: c.id,
      reason: reasons.join('; ') || 'Unavailable',
      allDay: workingWindows(pattern, theirs, date).length === 0,
      lost,
    }];
  });
}

const asOverride = (o: OverrideRow): Override => ({
  fromDate: calendarDateOf(o.fromDate),
  toDate: calendarDateOf(o.toDate),
  kind: o.kind,
  startMinute: o.startMinute ?? undefined,
  endMinute: o.endMinute ?? undefined,
});

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
