import { guarded } from '../auth/guard';
import { ownCaseloadOnly, type Actor } from '../auth/permissions';
import { systemClock, type Clock, DAY } from '../clock';
import { prisma } from '../db';
import { addDays, localDateOf, weekdayOf, zonedToUtc, type LocalDate } from '../time';

/**
 * The work-lists. Each one exists because something that ought to be visible
 * otherwise hides: a vacation against standing clients, a client who quietly
 * stopped booking, a cancellation nobody offered to the next person waiting.
 */

/**
 * Every standing client a clinician's absence displaces.
 *
 * A week off in a practice built on the same hour every week is this domain's
 * cascade: it is not one gap, it is fifteen conversations. So the absence
 * produces a work-list rather than fifteen silent holes in a calendar.
 */
export async function vacationImpact(
  actor: Actor,
  input: { clinicianId: string; fromDate: LocalDate; toDate: LocalDate },
) {
  return guarded(
    { actor, action: 'read', resource: 'appointment' },
    async (tx) => {
      const affected = await tx.appointment.findMany({
        where: {
          clinicianId: input.clinicianId,
          status: { in: ['scheduled', 'confirmed'] },
          startAt: { gte: zonedToUtc(input.fromDate, 0), lt: zonedToUtc(addDays(input.toDate, 1), 0) },
        },
        select: {
          id: true, startAt: true, endAt: true, modality: true, type: true, seriesId: true,
          client: { select: { id: true, code: true, firstName: true, lastName: true, reminderPreference: true } },
          room: { select: { id: true, name: true } },
        },
        orderBy: { startAt: 'asc' },
      });
      return affected.map((a) => ({
        ...a,
        date: localDateOf(a.startAt),
        standing: a.seriesId !== null,
      }));
    },
  );
}

/**
 * Clients whose last session completed and who have nothing booked.
 *
 * A therapy practice loses people quietly: someone cancels once, means to
 * rebook, and three months pass. Continuity-of-care lapses do not announce
 * themselves, so they get a list.
 */
export async function continuityQueue(
  actor: Actor,
  opts: { clock?: Clock; gapDays?: number } = {},
) {
  const now = (opts.clock ?? systemClock).now();
  const settings = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const gapDays = opts.gapDays ?? settings?.continuityGapDays ?? 21;
  const cutoff = new Date(now.getTime() - gapDays * DAY);
  const mineOnly = ownCaseloadOnly(actor);

  return guarded(
    {
      actor, action: 'read', resource: 'client',
      target: { clinicianId: actor.id, treatingSupervisorId: actor.id },
    },
    async (tx) => {
      const clients = await tx.client.findMany({
        where: {
          status: 'active',
          ...(mineOnly ? { treatingClinicianId: actor.id } : {}),
          // Nothing on the books from here on.
          appointments: { none: { startAt: { gte: now }, status: { in: ['scheduled', 'confirmed'] } } },
        },
        select: {
          id: true, code: true, firstName: true, lastName: true, reminderPreference: true,
          treatingClinician: { select: { id: true, name: true } },
          appointments: {
            where: { status: 'completed' },
            orderBy: { startAt: 'desc' },
            take: 1,
            select: { startAt: true },
          },
        },
      });

      return clients
        .map((c) => {
          const last = c.appointments[0]?.startAt ?? null;
          return {
            id: c.id, code: c.code, firstName: c.firstName, lastName: c.lastName,
            reminderPreference: c.reminderPreference,
            treatingClinician: c.treatingClinician,
            lastSessionAt: last,
            daysSince: last ? Math.floor((now.getTime() - last.getTime()) / DAY) : null,
          };
        })
        // A client who has never had a session is a booking problem, not a
        // continuity one — they belong to intake, and would drown this list.
        .filter((c) => c.lastSessionAt !== null && c.lastSessionAt < cutoff)
        .sort((a, b) => (b.daysSince ?? 0) - (a.daysSince ?? 0));
    },
  );
}

/**
 * P1-1. Unconfirmed and starting soon — the list a person works before the
 * policy does.
 *
 * This is the half of the confirmation feature that is not the money, and the
 * order matters: a practice that ships the fee without this one has automated
 * a penalty and nothing else. What front desk needs here is the phone number,
 * because the whole point of the list is to ring the client — which is also
 * why the list carries a number and a time and no reason for the appointment.
 *
 * `not_required` rows are in it too, and deliberately. A client on
 * `reminderPreference: 'none'` is never asked and can never be charged, which
 * makes them exactly the client somebody should be phoning (Q4). They are
 * flagged as never-asked rather than hidden, so the list does not quietly
 * reproduce the exemption as an absence.
 */
export async function unconfirmedSoon(
  actor: Actor,
  opts: { clock?: Clock; withinHours?: number } = {},
) {
  const now = (opts.clock ?? systemClock).now();
  const until = new Date(now.getTime() + (opts.withinHours ?? 48) * 3_600_000);

  return guarded(
    { actor, action: 'read', resource: 'appointment' },
    async (tx) => {
      const rows = await tx.appointment.findMany({
        where: {
          startAt: { gte: now, lte: until },
          status: { in: ['scheduled', 'confirmed'] },
          // Answered either way is off the list; a decline already cancelled
          // the hour, and `no_response` is behind us by definition.
          confirmation: { in: ['pending', 'not_required'] },
          ...(ownCaseloadOnly(actor) ? { clinicianId: actor.id } : {}),
        },
        select: {
          id: true, startAt: true, modality: true, status: true, confirmation: true,
          client: {
            select: {
              id: true, code: true, firstName: true, lastName: true,
              // The number is the feature. Nothing clinical rides with it.
              phone: true, reminderPreference: true,
            },
          },
          clinician: { select: { id: true, name: true } },
          reminders: { select: { stage: true }, orderBy: { dueAt: 'asc' } },
        },
        // Oldest start first: the session about to happen is the call to make.
        orderBy: { startAt: 'asc' },
      });

      return rows.map((r) => ({
        ...r,
        stagesSent: r.reminders.map((x) => x.stage),
        /** True where the practice never asked, and so may never charge. */
        neverAsked: r.confirmation === 'not_required',
      }));
    },
  );
}

/**
 * Who to offer a freed slot to. Surfaces candidates for a human to ring; it
 * never books. An automatic rebooking would put a client in a room with a
 * clinician neither of them chose for that hour.
 */
export async function waitlistMatches(
  actor: Actor,
  slot: { date: LocalDate; startMinute: number },
) {
  const weekday = weekdayOf(slot.date);
  return guarded(
    { actor, action: 'read', resource: 'client' },
    async (tx) => {
      const entries = await tx.waitlistEntry.findMany({
        where: { active: true },
        select: {
          id: true, weekdays: true, earliestMinute: true, latestMinute: true, note: true, createdAt: true,
          client: {
            select: {
              id: true, code: true, firstName: true, lastName: true, reminderPreference: true,
              treatingClinician: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      return entries.filter((e) => {
        if (e.weekdays.length && !e.weekdays.includes(weekday)) return false;
        if (e.earliestMinute !== null && slot.startMinute < e.earliestMinute) return false;
        if (e.latestMinute !== null && slot.startMinute > e.latestMinute) return false;
        return true;
      });
    },
  );
}
