import { guardedAll } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { prisma } from '../db';
import { systemClock, type Clock } from '../clock';
import { Conflict, NotFound } from '../errors';
import { zonedToUtc, type LocalDate } from '../time';
import { claimRoom, slotLock } from './booking';
import { cancelAppointment } from './lifecycle';
import { DURATION_MINUTES, type AppointmentType } from './recurrence';

type Modality = 'in_person' | 'telehealth';

/**
 * Group sessions: one hour, one clinician, one room, N clients.
 *
 * Modelled as N appointment rows sharing a `groupSessionId` rather than as one
 * appointment carrying a list of clients. That decision is the whole feature.
 * A group session is *not* a single clinical event — six people each get their
 * own note, their own fee, their own attendance record, and their own line in
 * the audit log, because those things are about a person and not about an hour.
 * Making the appointment plural would have meant rewriting every one of those
 * paths to ask "which attendee?"; keeping the appointment singular and the
 * booking plural means none of them changed at all.
 *
 * What it cost instead was two exclusion constraints, which now treat rows
 * sharing a group key as one booking of the clinician and the room.
 */

interface GroupBooking {
  clinicianId: string;
  clientIds: string[];
  date: LocalDate;
  startMinute: number;
  type?: AppointmentType;
  modality?: Modality;
  topic?: string | null;
  joinLink?: string | null;
  preferredRoomId?: string | null;
  /** When the booking is being made. See the insert in `booking.ts`. */
  clock?: Clock;
}

/**
 * Book the whole group or none of it.
 *
 * Room selection walks the candidates exactly as an individual booking does —
 * every attendee goes in the same room, so the whole set is inserted per
 * attempt and a room conflict moves all of them to the next room together.
 */
export async function bookGroupSession(actor: Actor, input: GroupBooking) {
  const at = (input.clock ?? systemClock).now();
  const clientIds = [...new Set(input.clientIds)];
  if (clientIds.length === 0) throw new Conflict('A group session needs at least one attendee', 'no_attendees');

  const type = input.type ?? 'standard';
  const modality = input.modality ?? 'in_person';
  const startAt = zonedToUtc(input.date, input.startMinute);
  const endAt = zonedToUtc(input.date, input.startMinute + DURATION_MINUTES[type]);

  const known = await prisma.client.count({ where: { id: { in: clientIds } } });
  if (known !== clientIds.length) throw new NotFound('Client');

  const candidates: (string | null)[] = [null];
  if (modality === 'in_person') {
    const rooms = await prisma.room.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    if (rooms.length === 0) throw new Conflict('No therapy rooms are configured', 'no_rooms');
    const ordered = input.preferredRoomId
      ? [...rooms.filter((r) => r.id === input.preferredRoomId), ...rooms.filter((r) => r.id !== input.preferredRoomId)]
      : rooms;
    candidates.length = 0;
    candidates.push(...ordered.map((r) => r.id));
  }

  const result = await claimRoom(candidates, (roomId) =>
    guardedAll(
      // One audit row per client record written to, not one per booking.
      clientIds.map((clientId) => ({
        actor, action: 'create' as const, resource: 'appointment' as const, clientId,
      })),
      async (tx) => {
        await slotLock(tx, input.date, input.startMinute);
        const group = await tx.groupSession.create({ data: { topic: input.topic ?? null } });
        await tx.appointment.createMany({
          data: clientIds.map((clientId) => ({
            clientId,
            clinicianId: input.clinicianId,
            roomId,
            groupSessionId: group.id,
            startAt,
            endAt,
            type,
            modality,
            joinLink: input.joinLink ?? null,
            // Both from the clock, for the reason spelled out in `booking.ts`:
            // an attendee's reminder stages are derived from `bookedAt`, and
            // `createdAt` must not come from the database's.
            createdAt: at,
            bookedAt: at,
          })),
        });
        return group.id;
      },
    ),
  );

  if (!('booked' in result)) {
    throw new Conflict(
      result.conflict === 'clinician'
        ? 'That clinician is already booked at this time'
        : 'No therapy room is free at this time',
      result.conflict === 'clinician' ? 'clinician_busy' : 'no_room',
    );
  }

  return getGroupSession(result.booked);
}

/** The group and its attendees. Roster and status only — no clinical content. */
export async function getGroupSession(groupSessionId: string) {
  const group = await prisma.groupSession.findUnique({
    where: { id: groupSessionId },
    include: {
      appointments: {
        select: {
          id: true, clientId: true, status: true, startAt: true, endAt: true, roomId: true,
          client: { select: { code: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!group) throw new NotFound('GroupSession');
  return group;
}

/**
 * Cancel every attendee's appointment.
 *
 * Each one goes through the ordinary cancellation, so each attendee is judged
 * against the late-cancel window on their own — the practice cancelling a group
 * is not the same event as one client dropping out of it, and the fee logic
 * already knows the difference.
 */
export async function cancelGroupSession(
  actor: Actor,
  groupSessionId: string,
  opts: { reason?: string; clock?: Clock } = {},
) {
  const clock = opts.clock ?? systemClock;
  const members = await prisma.appointment.findMany({
    where: { groupSessionId, status: { notIn: ['cancelled', 'late_cancelled'] } },
    select: { id: true },
  });

  const cancelled: string[] = [];
  for (const m of members) {
    await cancelAppointment(actor, m.id, { reason: opts.reason, clock });
    cancelled.push(m.id);
  }
  return { cancelled };
}
