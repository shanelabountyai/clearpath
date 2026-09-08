import { guarded, guardedAll } from '../auth/guard';
import { ownCaseloadOnly, type Actor } from '../auth/permissions';
import { systemClock, type Clock, DAY, HOUR } from '../clock';
import { prisma } from '../db';
import { addDays, localDateOf, utcToZoned, weekdayOf, zonedToUtc, type LocalDate } from '../time';

/**
 * The work-lists. Each one exists because something that ought to be visible
 * otherwise hides: an hour tomorrow nobody has answered about, a vacation
 * against standing clients, a client who quietly stopped booking, a
 * cancellation nobody offered to the next person waiting.
 */

/**
 * The hours nobody has said they are coming to, soonest first, with a phone
 * number.
 *
 * Every other surface in this feature is about what the practice *sent*. This
 * one is about the gap the sending leaves: a client who never answered is not a
 * message problem, they are a phone call, and the fee that follows silence is
 * only defensible if somebody had the chance to make it. So the list carries
 * the number rather than a link to a record that carries the number — a work
 * list you have to click through twice is a work list nobody works.
 *
 * `confirmation: not confirmed` rather than `pending`, deliberately. Three
 * different silences land here and they are the same job: nobody was asked
 * (`not_required` — the client is on `none`, or booked inside the grace
 * window), somebody was asked and has not answered (`pending`), and somebody
 * said no in a way that could not free the room (`declined` on a session still
 * standing, which is what an inbound keyword decline inside the fee window
 * leaves behind). `status: 'scheduled'` is what keeps it short: an hour front
 * desk has already marked `confirmed` by hand is an hour somebody has spoken
 * to them about.
 */
export async function unconfirmedSoon(
  actor: Actor,
  opts: { clock?: Clock; withinHours?: number } = {},
) {
  const now = (opts.clock ?? systemClock).now();
  const until = new Date(now.getTime() + (opts.withinHours ?? 48) * HOUR);

  return guarded(
    { actor, action: 'read', resource: 'appointment' },
    (tx) =>
      tx.appointment.findMany({
        where: {
          status: 'scheduled',
          confirmation: { not: 'confirmed' },
          startAt: { gte: now, lte: until },
        },
        select: {
          id: true, startAt: true, modality: true, confirmation: true,
          client: {
            select: {
              id: true, code: true, firstName: true, lastName: true,
              phone: true, reminderPreference: true,
            },
          },
          clinician: { select: { name: true } },
        },
        orderBy: { startAt: 'asc' },
      }),
  );
}

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
 * The entry shape both waitlist surfaces read. Exactly one of the two branches
 * is present on any row — the database enforces that, not this select.
 */
const ENTRY_SELECT = {
  id: true, weekdays: true, earliestMinute: true, latestMinute: true, note: true, createdAt: true,
  client: {
    select: {
      id: true, code: true, firstName: true, lastName: true, reminderPreference: true,
      treatingClinician: { select: { id: true, name: true } },
    },
  },
  /**
   * A caller who is not yet anybody (P0-7). No code and no treating clinician,
   * because there is neither — front desk is ringing a stranger, and a screen
   * that renders blanks where those go is a screen that hides which call this
   * is. The number comes with the row for the same reason `unconfirmedSoon`
   * carries one: a work list you have to click through twice is a work list
   * nobody works.
   */
  inquiry: { select: { id: true, firstName: true, lastName: true, phone: true } },
} as const;

/** Does this entry's stated preference cover that hour? Pure, so both callers agree. */
const fits = (
  e: { weekdays: number[]; earliestMinute: number | null; latestMinute: number | null },
  weekday: number,
  startMinute: number,
): boolean => {
  if (e.weekdays.length && !e.weekdays.includes(weekday)) return false;
  if (e.earliestMinute !== null && startMinute < e.earliestMinute) return false;
  if (e.latestMinute !== null && startMinute > e.latestMinute) return false;
  return true;
};

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
        select: ENTRY_SELECT,
        orderBy: { createdAt: 'asc' },
      });
      return entries.filter((e) => fits(e, weekday, slot.startMinute));
    },
  );
}

/**
 * The hours that are about to be empty, each with the people who want one.
 *
 * The waitlist could always answer "who fits Tuesday at three"; what it could
 * not do was say which Tuesday at three was going spare. That question is
 * already answered elsewhere in the record and was simply never joined up: a
 * cancellation frees an hour outright, and a client who *declined* has told the
 * practice they are not coming — five days out, at `d5`, that is the longest
 * notice this system ever gets, and it is exactly the notice a waitlisted
 * client can use.
 *
 * The two are shown together and labelled apart, because they are not the same
 * offer. A cancelled hour is free. A declined one is still on the books, and
 * stays there until somebody rings the client and cancels it properly — an
 * inbound `NO` may record an answer but must never move a session or a fee
 * (see `messaging/inbound.ts`), so front desk has two calls to make here, not
 * one, and offering the hour before making the first is how a client arrives to
 * find their room taken.
 *
 * Nothing is booked, offered or messaged from here. Same rule as the matcher it
 * is built on: this is a list of phone calls.
 */
export async function waitlistOpenings(
  actor: Actor,
  opts: { clock?: Clock; withinDays?: number } = {},
) {
  const now = (opts.clock ?? systemClock).now();
  const until = new Date(now.getTime() + (opts.withinDays ?? 30) * DAY);

  return guardedAll(
    [
      { actor, action: 'read' as const, resource: 'appointment' as const },
      { actor, action: 'read' as const, resource: 'client' as const },
    ],
    async (tx) => {
      const openings = await tx.appointment.findMany({
        where: {
          startAt: { gte: now, lte: until },
          OR: [
            { status: { in: ['cancelled', 'late_cancelled'] } },
            { status: 'scheduled', confirmation: 'declined' },
          ],
        },
        select: {
          id: true, startAt: true, endAt: true, modality: true, status: true,
          confirmation: true, declineReason: true, clientId: true,
          client: { select: { code: true, firstName: true, lastName: true } },
          clinician: { select: { id: true, name: true } },
          room: { select: { name: true } },
        },
        orderBy: { startAt: 'asc' },
      });
      if (openings.length === 0) return [];

      // One query for the whole list rather than one per opening: the matching
      // rule is cheap and the round trips are not.
      const entries = await tx.waitlistEntry.findMany({
        where: { active: true },
        select: ENTRY_SELECT,
        orderBy: { createdAt: 'asc' },
      });

      return openings.map((o) => {
        const when = utcToZoned(o.startAt);
        return {
          ...o,
          date: when.date,
          startMinute: when.minutes,
          /** Free now, versus told-us-they-are-not-coming. */
          freed: o.status !== 'scheduled',
          noticeHours: Math.floor((o.startAt.getTime() - now.getTime()) / HOUR),
          matches: entries.filter(
            // Never offer a client the hour they just gave back. An inquiry
            // entry is skipped by the same comparison rather than exempted
            // from it: by construction it gave nothing back.
            (e) => e.client?.id !== o.clientId && fits(e, when.weekday, when.minutes),
          ),
        };
      });
    },
  );
}
