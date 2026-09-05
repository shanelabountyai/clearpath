import type { Actor } from '../auth/permissions';
import { guarded } from '../auth/guard';
import { prisma, type Tx } from '../db';
import { systemClock, type Clock } from '../clock';
import { Conflict, NotFound } from '../errors';
import { addDays, localDateOf, zonedToUtc, type LocalDate } from '../time';
import { freeSlots, pickRoom, workingWindows, type Span } from './availability';
import { DURATION_MINUTES, occurrenceKey, planOccurrences, type AppointmentType } from './recurrence';

type Modality = 'in_person' | 'telehealth';

const ACTIVE_STATUSES = ['scheduled', 'confirmed', 'arrived', 'in_session', 'completed', 'no_show'] as const;

/**
 * Postgres decides. The EXCLUDE constraints on clinician and room are the
 * booking lock: a read-then-write check in application code cannot be made safe
 * against a concurrent booking of the last room, and every attempt to try leaves
 * a window. So the insert is the check, and 23P01 is a normal outcome to handle
 * rather than an error to log.
 */
function conflictKind(e: unknown): 'room' | 'clinician' | null {
  const text = e instanceof Error ? `${e.message}${'meta' in e ? JSON.stringify((e as { meta?: unknown }).meta) : ''}` : '';
  if (text.includes('appointment_room_no_overlap')) return 'room';
  if (text.includes('appointment_clinician_no_overlap')) return 'clinician';
  return null;
}

/**
 * Postgres asking to be asked again.
 *
 * P2034 is a write conflict or deadlock, P2028 a transaction that ran out of
 * budget waiting. Neither is an answer about whether the room is free — the
 * database is saying it could not decide this time. Treating them as "no room
 * available", which is what any `catch` that only understands constraint
 * violations does, tells a client the practice is full while a room sits empty.
 */
const RETRYABLE = new Set(['P2034', 'P2028']);

const isRetryable = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && RETRYABLE.has(String((e as { code?: unknown }).code));

/**
 * One booking at a time per time slot.
 *
 * The exclusion constraints make double-booking impossible, but they do not make
 * a *rejection* meaningful. Without this lock, `23P01` means either "that room is
 * booked" or "another transaction is part-way through booking it and may still
 * roll back" — and the two are indistinguishable to the caller. Ten concurrent
 * bookings of the same hour therefore all walk past a room that ends up empty,
 * and every one of them is told the practice is full. Measured: three runs in
 * forty filled three of four rooms and rejected seven requests.
 *
 * Holding an advisory lock on the slot for the length of the attempt makes the
 * answer honest: inside it, a conflict is a *committed* conflict. It also gives
 * every contender the same lock ordering, which is what removes the deadlock
 * storm — Postgres was aborting these transactions in pairs.
 *
 * The lock is per slot, not global: two different hours never wait on each other.
 */
export const slotLock = (tx: Tx, date: LocalDate, startMinute: number) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${date}T${startMinute}`})::bigint)`;

/**
 * Attempts allowed per candidate room before moving on.
 *
 * With the slot lock in place a retry is for the residual — a deadlock against
 * some *other* slot's transaction touching the same client or clinician row —
 * so the budget is small on purpose. A large one here would only slow down the
 * honest answer that a room is genuinely taken.
 */
const ATTEMPTS_PER_ROOM = 3;

/**
 * Desynchronise the retry.
 *
 * Retrying instantly means the same set of transactions collide in the same
 * order and deadlock again — the pile never drains, it just re-forms. The jitter
 * matters more than the delay: it is what stops lockstep.
 */
const backoff = (attempt: number) =>
  new Promise<void>((r) => setTimeout(r, 5 + Math.random() * 15 * (attempt + 1)));

/**
 * Walk the candidate rooms, letting the database arbitrate each attempt.
 *
 * Shared by booking and rescheduling because they are the same problem: a
 * conflict on a room means try the next one, a conflict on the clinician means
 * stop (there is no second clinician to fall through to), and a write conflict
 * means the question was never answered, so ask again.
 */
export async function claimRoom<T>(
  candidates: readonly (string | null)[],
  attempt: (roomId: string | null) => Promise<T>,
): Promise<{ booked: T } | { conflict: 'room' | 'clinician' | null }> {
  let lastConflict: 'room' | 'clinician' | null = null;

  for (const roomId of candidates) {
    for (let tries = 0; tries < ATTEMPTS_PER_ROOM; tries++) {
      try {
        return { booked: await attempt(roomId) };
      } catch (e) {
        const kind = conflictKind(e);
        if (kind !== null) {
          lastConflict = kind;
          break; // Decided: this room (or the clinician) is genuinely taken.
        }
        if (!isRetryable(e)) throw e;
        // Undecided. The same room may still be free, so ask again — after a
        // pause, so this attempt does not re-collide with the one it lost to.
        await backoff(tries);
      }
    }
    if (lastConflict === 'clinician') break;
  }

  return { conflict: lastConflict };
}

const spanOf = (a: { startAt: Date; endAt: Date }, date: LocalDate): Span => {
  const midnight = zonedToUtc(date, 0).getTime();
  return {
    startMinute: Math.round((a.startAt.getTime() - midnight) / 60_000),
    endMinute: Math.round((a.endAt.getTime() - midnight) / 60_000),
  };
};

/** Everything booked on one local date, for slot arithmetic. */
async function dayLoad(db: Tx | typeof prisma, date: LocalDate) {
  return db.appointment.findMany({
    where: {
      startAt: { gte: zonedToUtc(date, 0), lt: zonedToUtc(addDays(date, 1), 0) },
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: { id: true, clinicianId: true, roomId: true, startAt: true, endAt: true },
  });
}

interface SlotQuery {
  clinicianId: string;
  date: LocalDate;
  type: AppointmentType;
  modality: Modality;
}

/**
 * Start times front desk may offer.
 *
 * The conditional resource lives here: a telehealth session needs the clinician
 * free and nothing else, so a full room map never blocks a video session.
 */
export async function availableSlots(q: SlotQuery): Promise<number[]> {
  const duration = DURATION_MINUTES[q.type];
  const [weekly, overrides, load, rooms] = await Promise.all([
    prisma.availability.findMany({ where: { userId: q.clinicianId } }),
    prisma.availabilityOverride.findMany({ where: { userId: q.clinicianId } }),
    dayLoad(prisma, q.date),
    prisma.room.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
  ]);

  const windows = workingWindows(
    weekly,
    overrides.map((o) => ({
      fromDate: localDateOf(o.fromDate), toDate: localDateOf(o.toDate),
      kind: o.kind, startMinute: o.startMinute ?? undefined, endMinute: o.endMinute ?? undefined,
    })),
    q.date,
  );

  const clinicianBusy = load.filter((a) => a.clinicianId === q.clinicianId).map((a) => spanOf(a, q.date));
  const candidates = freeSlots({ windows, busy: clinicianBusy, duration });
  if (q.modality === 'telehealth') return candidates;

  const busyByRoom = new Map<string, Span[]>();
  for (const a of load) {
    if (!a.roomId) continue;
    busyByRoom.set(a.roomId, [...(busyByRoom.get(a.roomId) ?? []), spanOf(a, q.date)]);
  }
  return candidates.filter(
    (start) => pickRoom(rooms, busyByRoom, { startMinute: start, endMinute: start + duration }) !== null,
  );
}

interface BookInput {
  clientId: string;
  clinicianId: string;
  date: LocalDate;
  startMinute: number;
  type: AppointmentType;
  modality: Modality;
  joinLink?: string | null;
  seriesId?: string | null;
  occurrenceKey?: string | null;
  /** Try this room first; fall through to any other free one. */
  preferredRoomId?: string | null;
  /**
   * When the booking is being made. Stamped onto `createdAt` rather than left
   * to the column default, because the confirmation cadence reads it as the
   * notice the client had — see the comment on the insert below.
   */
  clock?: Clock;
}

/**
 * Reserve clinician and, for in-person, a room — together or not at all.
 *
 * Room selection is optimistic: pick a candidate, insert, and let the database
 * arbitrate. On a room collision try the next candidate; on a clinician
 * collision stop, because there is no second clinician to fall through to.
 */
export async function bookAppointment(actor: Actor, input: BookInput) {
  const clock = input.clock ?? systemClock;
  const duration = DURATION_MINUTES[input.type];
  const startAt = zonedToUtc(input.date, input.startMinute);
  const endAt = zonedToUtc(input.date, input.startMinute + duration);

  const candidates: (string | null)[] = [null];
  if (input.modality === 'in_person') {
    const rooms = await prisma.room.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    if (rooms.length === 0) throw new Conflict('No therapy rooms are configured', 'no_rooms');
    const ordered = input.preferredRoomId
      ? [...rooms.filter((r) => r.id === input.preferredRoomId), ...rooms.filter((r) => r.id !== input.preferredRoomId)]
      : rooms;
    candidates.length = 0;
    candidates.push(...ordered.map((r) => r.id));
  }

  const result = await claimRoom(candidates, (roomId) =>
    guarded(
      { actor, action: 'create', resource: 'appointment', clientId: input.clientId },
      async (tx) => {
        await slotLock(tx, input.date, input.startMinute);
        return tx.appointment.create({
          data: {
            clientId: input.clientId,
            clinicianId: input.clinicianId,
            roomId,
            startAt,
            endAt,
            type: input.type,
            modality: input.modality,
            joinLink: input.joinLink ?? null,
            seriesId: input.seriesId ?? null,
            occurrenceKey: input.occurrenceKey ?? null,
            // Written, not defaulted. `dueStages` treats this as the notice the
            // booking had, so it decides which reminder stages were ever
            // sendable and therefore whether silence can become a fee. Left to
            // `@default(now())` it would come from the database clock, which
            // the pg adapter labels in the session's timezone — self-consistent
            // for everything the application writes, and skewed for the one
            // column it does not. Hard rule 7 has no exception for defaults.
            createdAt: clock.now(),
          },
        });
      },
    ),
  );
  if ('booked' in result) return result.booked;

  throw new Conflict(
    result.conflict === 'clinician'
      ? 'That clinician is already booked at this time'
      : 'No therapy room is free at this time',
    result.conflict === 'clinician' ? 'clinician_busy' : 'no_room',
  );
}

/**
 * Materialise a series up to the horizon. Safe to run repeatedly and safe to
 * run after an edit: it creates what is missing and withdraws only future,
 * unstarted, still-attached instances that no longer match the pattern.
 */
export async function materialiseSeries(
  actor: Actor,
  seriesId: string,
  opts: { from?: LocalDate; horizonDays?: number; clock?: Clock } = {},
) {
  const series = await prisma.appointmentSeries.findUnique({ where: { id: seriesId } });
  if (!series) throw new NotFound('AppointmentSeries');

  const settings = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const horizon = opts.horizonDays ?? settings?.recurrenceHorizonDays ?? 90;
  const clock = opts.clock ?? systemClock;
  const from = opts.from ?? localDateOf(clock.now());
  const window = { from: from < localDateOf(series.startDate) ? localDateOf(series.startDate) : from, to: addDays(from, horizon) };

  const existing = await prisma.appointment.findMany({
    where: { seriesId },
    select: { id: true, startAt: true, endAt: true, detached: true, status: true, occurrenceKey: true },
  });

  const plan = planOccurrences(
    {
      frequency: series.frequency,
      weekday: series.weekday,
      startDate: localDateOf(series.startDate),
      endDate: series.endDate ? localDateOf(series.endDate) : null,
    },
    existing.map((a) => ({
      id: a.id,
      // The slot the series produced, recovered from the occurrence key, so a
      // rescheduled instance still counts as filling its original week.
      occurrenceDate: a.occurrenceKey?.slice(seriesId.length + 1) ?? localDateOf(a.startAt),
      date: localDateOf(a.startAt),
      startMinute: spanOf(a, localDateOf(a.startAt)).startMinute,
      detached: a.detached,
      status: a.status,
    })),
    window,
    { startMinute: series.startMinute, active: series.active },
  );

  const created: string[] = [];
  const skipped: LocalDate[] = [];
  for (const date of plan.create) {
    try {
      const appt = await bookAppointment(actor, {
        clientId: series.clientId,
        clinicianId: series.clinicianId,
        date,
        startMinute: series.startMinute,
        type: series.type,
        modality: series.modality,
        seriesId,
        occurrenceKey: occurrenceKey(seriesId, date),
        preferredRoomId: series.roomId,
        clock,
      });
      created.push(appt.id);
    } catch (e) {
      // A standing slot the practice cannot honour this week is front-desk work,
      // not a crash: the rest of the horizon still materialises.
      if (e instanceof Conflict) skipped.push(date);
      else throw e;
    }
  }

  const withdrawn = plan.obsolete.map((o) => o.id);
  if (withdrawn.length) {
    await guarded(
      { actor, action: 'update', resource: 'appointment', clientId: series.clientId },
      (tx) =>
        tx.appointment.updateMany({
          where: { id: { in: withdrawn } },
          data: { status: 'cancelled', cancelReason: 'series updated', cancelledAt: clock.now() },
        }),
    );
  }

  return { created, withdrawn, skipped };
}

/**
 * Move one instance. It detaches from its pattern and stops being regenerated —
 * it keeps its occurrence key, so the horizon run does not helpfully refill the
 * slot the client just moved out of.
 */
export async function rescheduleAppointment(
  actor: Actor,
  appointmentId: string,
  to: { date: LocalDate; startMinute: number; modality?: Modality; type?: AppointmentType },
) {
  const current = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!current) throw new NotFound('Appointment');

  const type = to.type ?? current.type;
  const modality = to.modality ?? current.modality;
  const startAt = zonedToUtc(to.date, to.startMinute);
  const endAt = zonedToUtc(to.date, to.startMinute + DURATION_MINUTES[type]);

  const rooms = modality === 'in_person'
    ? await prisma.room.findMany({ where: { active: true }, orderBy: { name: 'asc' } })
    : [];
  const candidates: (string | null)[] = modality === 'in_person' ? rooms.map((r) => r.id) : [null];

  const result = await claimRoom(candidates, (roomId) =>
    guarded(
      { actor, action: 'update', resource: 'appointment', resourceId: appointmentId, clientId: current.clientId },
      async (tx) => {
        await slotLock(tx, to.date, to.startMinute);
        return tx.appointment.update({
          where: { id: appointmentId },
          data: {
            startAt, endAt, roomId, type, modality,
            detached: current.seriesId ? true : false,
            // Moving an attendee out of the hour moves them out of the group.
            // Keeping the key would let two members be rescheduled onto each
            // other and double-book the clinician, since co-attendees are
            // exempt from the overlap constraint by design.
            groupSessionId: null,
          },
        });
      },
    ),
  );
  if ('booked' in result) return result.booked;

  throw new Conflict(
    result.conflict === 'clinician' ? 'That clinician is already booked at this time' : 'No therapy room is free at this time',
    result.conflict === 'clinician' ? 'clinician_busy' : 'no_room',
  );
}
