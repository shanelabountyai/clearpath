import { guarded } from '../auth/guard';
import { ownCaseloadOnly, type Actor } from '../auth/permissions';
import { systemClock, type Clock, DAY } from '../clock';
import { prisma } from '../db';
import { addDays, localDateOf, utcToZoned, weekdayOf, zonedToUtc, type LocalDate } from '../time';
import { workingWindows, type Override } from './availability';
import {
  describeNotice, fillability, openingSuits,
  type Opening, type WaitlistPreference,
} from './openings';

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
 * P2. Clients the practice tried to message and could not reach.
 *
 * This list exists because of what the delivery precondition does *not* do. Once
 * the fee requires a delivery receipt, a client with a dead number stops being
 * charged — which is right, and which is also completely silent. The practice
 * would simply stop hearing from them, keep booking them, keep not reaching
 * them, and find out at the point they stopped coming.
 *
 * So the exemption produces a phone call. Same shape as `unconfirmedSoon` and
 * for the same reason: the number is the feature, and nothing about why the
 * client is attending rides along with it.
 *
 * Scoped to failures the practice can still act on — a permanent failure inside
 * the window, with nothing delivered to that client since. A client whose
 * number was fixed on Tuesday drops off the list on Tuesday, without anybody
 * marking anything as handled.
 */
export async function unreachableClients(
  actor: Actor,
  opts: { clock?: Clock; withinDays?: number } = {},
) {
  const now = (opts.clock ?? systemClock).now();
  const since = new Date(now.getTime() - (opts.withinDays ?? 30) * DAY);

  return guarded(
    {
      actor, action: 'read', resource: 'client',
      target: { clinicianId: actor.id, treatingSupervisorId: actor.id },
    },
    async (tx) => {
      const failures = await tx.outboxMessage.findMany({
        where: {
          clientId: { not: null },
          deliveryState: 'failed',
          decidedAt: { gte: since },
          // `expired` is the practice running out of time, not the client being
          // unreachable — a message abandoned because its hour started says
          // nothing about the number. It belongs to the cadence's timing, and
          // putting it here would send front desk to ring people who are fine.
          failureCode: { not: 'expired' },
          ...(ownCaseloadOnly(actor) ? { client: { treatingClinicianId: actor.id } } : {}),
        },
        select: {
          clientId: true, channel: true, failureCode: true, decidedAt: true,
          client: {
            select: {
              id: true, code: true, firstName: true, lastName: true,
              phone: true, email: true, reminderPreference: true, status: true,
              treatingClinician: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { decidedAt: 'desc' },
      });

      // One row per client, newest failure first: front desk needs a call list,
      // not a message log.
      const byClient = new Map<string, (typeof failures)[number] & { failures: number }>();
      for (const f of failures) {
        if (!f.client || f.client.status !== 'active') continue;
        const seen = byClient.get(f.client.id);
        if (seen) seen.failures++;
        else byClient.set(f.client.id, { ...f, failures: 1 });
      }
      if (byClient.size === 0) return [];

      // Anything that has arrived since clears the client, so a corrected
      // number takes them off the list without anybody marking it handled.
      const recovered = await tx.outboxMessage.findMany({
        where: {
          clientId: { in: [...byClient.keys()] },
          deliveryState: 'delivered',
          deliveredAt: { gte: since },
        },
        select: { clientId: true, deliveredAt: true },
      });
      for (const r of recovered) {
        const entry = r.clientId ? byClient.get(r.clientId) : undefined;
        if (entry && r.deliveredAt && entry.decidedAt && r.deliveredAt > entry.decidedAt) {
          byClient.delete(r.clientId!);
        }
      }

      return [...byClient.values()]
        .map((f) => ({
          client: f.client!,
          channel: f.channel,
          failureCode: f.failureCode,
          lastFailureAt: f.decidedAt,
          failures: f.failures,
          treatingClinician: f.client!.treatingClinician,
        }))
        .sort((a, b) => (b.lastFailureAt?.getTime() ?? 0) - (a.lastFailureAt?.getTime() ?? 0));
    },
  );
}

/**
 * Who to offer a freed slot to. Surfaces candidates for a human to ring; it
 * never books. An automatic rebooking would put a client in a room with a
 * clinician neither of them chose for that hour.
 *
 * The slot carries a clinician because the match rule needs one: continuity is
 * the first thing `openingSuits` checks, and a signature that let a caller omit
 * it would be a signature that let a caller skip it.
 */
export async function waitlistMatches(
  actor: Actor,
  slot: { date: LocalDate; startMinute: number; clinicianId: string; exceptClientId?: string },
) {
  const opening: Opening = {
    weekday: weekdayOf(slot.date),
    startMinute: slot.startMinute,
    clinicianId: slot.clinicianId,
    clientId: slot.exceptClientId ?? '',
  };

  return guarded(
    {
      actor, action: 'read', resource: 'client',
      // The same self-target the other client-reading work-lists use: the rule
      // for a therapist is `treatingOrSupervising`, and a list query has no one
      // row to name. The WHERE clause below does the real scoping — here the
      // continuity filter already guarantees it, since an entry only survives
      // `openingSuits` when the waiting client is this clinician's.
      target: { clinicianId: actor.id, treatingSupervisorId: actor.id },
    },
    async (tx) => {
      const entries = await tx.waitlistEntry.findMany({
        where: { active: true, client: { status: 'active' } },
        select: WAITLIST_SELECT,
        orderBy: { createdAt: 'asc' },
      });
      return entries.filter((e) => openingSuits(preferenceOf(e), opening));
    },
  );
}

/** Everything the call actually needs: a name, a number, and nothing clinical. */
const WAITLIST_SELECT = {
  id: true, weekdays: true, earliestMinute: true, latestMinute: true, note: true, createdAt: true,
  client: {
    select: {
      id: true, code: true, firstName: true, lastName: true, phone: true, reminderPreference: true,
      treatingClinicianId: true,
      treatingClinician: { select: { id: true, name: true } },
    },
  },
} as const;

type WaitlistRow = {
  weekdays: number[];
  earliestMinute: number | null;
  latestMinute: number | null;
  client: { id: string; treatingClinicianId: string };
};

const preferenceOf = (e: WaitlistRow): WaitlistPreference => ({
  clientId: e.client.id,
  weekdays: e.weekdays,
  earliestMinute: e.earliestMinute,
  latestMinute: e.latestMinute,
  treatingClinicianId: e.client.treatingClinicianId,
});

/**
 * P2-2. Hours the practice has back, and who has been waiting for one.
 *
 * The confirmation loop's other half. Five phases went into deciding what a
 * client's silence means and what it may cost them; this is what their *answer*
 * is worth, and it is the first thing built here that is worth something to a
 * client rather than protecting one. A decline at `d5` is not primarily a fee
 * that was avoided — it is five days' notice of an empty hour, which is exactly
 * what somebody who has been on a waiting list for six weeks can use.
 *
 * It is every future cancellation, not only the declined ones. A front-desk
 * cancellation empties the same hour as a keyword reply, and a list that showed
 * one and not the other would leave holes in the week that nobody was looking
 * for — which is the failure every work-list on this page exists to prevent.
 *
 * Four things keep the list true rather than merely long, and all four are
 * derived, so nothing is ever marked as handled and nothing is ever tidied away:
 *
 *   - **An hour somebody was rebooked into is not free.** The check is against
 *     the clinician's live sessions, which is also what makes a group session
 *     behave: one attendee dropping out leaves the clinician running the group,
 *     so no opening appears, and only a group that emptied completely produces
 *     one.
 *   - **An hour the clinician is not working is not free either.** A week of
 *     leave cancels fifteen sessions, and without this the vacation work-list
 *     and this one would describe the same absence in opposite words — one as
 *     fifteen conversations to have, the other as fifteen hours to sell.
 *   - **The same hour is one opening**, however many cancelled rows point at it.
 *   - **The hour has not started.** Nothing else is hidden: the slot two hours
 *     out that will probably not be filled is on the list, ranked last and
 *     labelled for what it is, because a system that decides on front desk's
 *     behalf that a slot is hopeless is how an hour goes quietly empty.
 */
export async function freedSlots(
  actor: Actor,
  opts: { clock?: Clock; horizonDays?: number } = {},
) {
  const now = (opts.clock ?? systemClock).now();
  const horizon = new Date(now.getTime() + (opts.horizonDays ?? 30) * DAY);
  const mineOnly = ownCaseloadOnly(actor);

  const openings = await guarded(
    { actor, action: 'read', resource: 'appointment' },
    async (tx) => {
      const cancelled = await tx.appointment.findMany({
        where: {
          status: { in: ['cancelled', 'late_cancelled'] },
          startAt: { gt: now, lt: horizon },
          ...(mineOnly ? { clinicianId: actor.id } : {}),
        },
        select: {
          id: true, startAt: true, endAt: true, modality: true, type: true,
          confirmation: true, cancelledAt: true, clientId: true, clinicianId: true,
          clinician: { select: { id: true, name: true } },
          room: { select: { id: true, name: true } },
        },
        orderBy: { startAt: 'asc' },
      });
      if (cancelled.length === 0) return [];

      const clinicianIds = [...new Set(cancelled.map((a) => a.clinicianId))];

      const [live, weekly, overrides] = await Promise.all([
        // Anything not cancelled still occupies the clinician's hour — a
        // no-show and a completed session both mean they were not free.
        tx.appointment.findMany({
          where: {
            clinicianId: { in: clinicianIds },
            status: { notIn: ['cancelled', 'late_cancelled'] },
            startAt: { lt: horizon },
            endAt: { gt: now },
          },
          select: { clinicianId: true, startAt: true, endAt: true },
        }),
        tx.availability.findMany({ where: { userId: { in: clinicianIds } } }),
        tx.availabilityOverride.findMany({ where: { userId: { in: clinicianIds } } }),
      ]);

      const overridesFor = (userId: string): Override[] =>
        overrides
          .filter((o) => o.userId === userId)
          .map((o) => ({
            fromDate: localDateOf(o.fromDate), toDate: localDateOf(o.toDate),
            kind: o.kind,
            startMinute: o.startMinute ?? undefined,
            endMinute: o.endMinute ?? undefined,
          }));

      const seen = new Set<string>();
      const out = [];

      for (const a of cancelled) {
        const key = `${a.clinicianId}@${a.startAt.getTime()}`;
        if (seen.has(key)) continue;

        const busy = live.some(
          (l) => l.clinicianId === a.clinicianId && l.startAt < a.endAt && l.endAt > a.startAt,
        );
        if (busy) continue;

        const { date, minutes, weekday } = utcToZoned(a.startAt);
        const endMinute = minutes + Math.round((a.endAt.getTime() - a.startAt.getTime()) / 60_000);
        const working = workingWindows(
          weekly.filter((w) => w.userId === a.clinicianId),
          overridesFor(a.clinicianId),
          date,
        );
        // The whole session has to fit inside a window the clinician is
        // actually working. A half-covered hour is not an hour to sell.
        if (!working.some((w) => w.startMinute <= minutes && endMinute <= w.endMinute)) continue;

        seen.add(key);
        out.push({
          appointmentId: a.id,
          startAt: a.startAt,
          endAt: a.endAt,
          date,
          startMinute: minutes,
          weekday,
          modality: a.modality,
          type: a.type,
          room: a.room,
          clinician: a.clinician,
          /** Whether the client answered the reminder, or the desk cancelled it. */
          confirmation: a.confirmation,
          cancelledAt: a.cancelledAt,
          notice: describeNotice(a.startAt, now),
          fillability: fillability(a.startAt, now),
          opening: {
            weekday, startMinute: minutes,
            clinicianId: a.clinicianId, clientId: a.clientId,
          } satisfies Opening,
        });
      }
      return out;
    },
  );

  if (openings.length === 0) return [];

  // A second read, and a second audit row, because it is a second thing: the
  // hours are appointment data and the people to ring are client data.
  const entries = await guarded(
    {
      actor, action: 'read', resource: 'client',
      target: { clinicianId: actor.id, treatingSupervisorId: actor.id },
    },
    async (tx) =>
      tx.waitlistEntry.findMany({
        where: {
          active: true,
          client: {
            status: 'active',
            treatingClinicianId: { in: [...new Set(openings.map((o) => o.opening.clinicianId))] },
          },
        },
        select: WAITLIST_SELECT,
        // Longest wait first. The list is a queue before it is a match.
        orderBy: { createdAt: 'asc' },
      }),
  );

  return openings.map(({ opening, ...slot }) => ({
    ...slot,
    candidates: entries.filter((e) => openingSuits(preferenceOf(e), opening)),
  }));
}
