import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Conflict, Forbidden } from '../errors';
import { fixedClock, DAY } from '../clock';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment, rescheduleAppointment } from './booking';
import { bookGroupSession, cancelGroupSession, getGroupSession } from './groups';
import { setStatus } from './lifecycle';
import { createProgressNote, getProgressNote, listProgressNotes } from '../notes/service';

const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;

let desk: Awaited<ReturnType<typeof makeUser>>;
let clinician: Awaited<ReturnType<typeof makeUser>>;

async function attendees(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await makeClient(clinician.id));
  return out;
}

beforeEach(async () => {
  await resetDb();
  await settings();
  desk = await makeUser('front_desk');
  clinician = await makeUser('therapist');
  await prisma.availability.create({
    data: { userId: clinician.id, weekday: 2, startMinute: 540, endMinute: 1020 },
  });
});
afterAll(() => prisma.$disconnect());

const book = (clientIds: string[], over: Record<string, unknown> = {}) =>
  bookGroupSession(actor(desk), {
    clinicianId: clinician.id, clientIds, date: TUESDAY, startMinute: THREE_PM,
    topic: 'Tuesday skills group', ...over,
  });

describe('one hour, one clinician, one room, N clients', () => {
  it('gives every attendee their own appointment in the same room at the same time', async () => {
    await makeRoom('Room 1');
    const group = await book((await attendees(4)).map((c) => c.id));

    expect(group.appointments).toHaveLength(4);
    expect(new Set(group.appointments.map((a) => a.roomId)).size).toBe(1);
    expect(new Set(group.appointments.map((a) => a.startAt.getTime())).size).toBe(1);
    expect(new Set(group.appointments.map((a) => a.clientId)).size).toBe(4);
  });

  it('does not double-book the clinician against themselves', async () => {
    await makeRoom('Room 1');
    await expect(book((await attendees(6)).map((c) => c.id))).resolves.toBeTruthy();
    expect(await prisma.appointment.count()).toBe(6);
  });

  it('still blocks an unrelated booking of the same clinician at that hour', async () => {
    await makeRoom('Room 1');
    await makeRoom('Room 2');
    await book((await attendees(3)).map((c) => c.id));

    const outsider = await makeClient(clinician.id);
    await expect(
      bookAppointment(actor(desk), {
        clientId: outsider.id, clinicianId: clinician.id, date: TUESDAY,
        startMinute: THREE_PM, type: 'standard', modality: 'in_person',
      }),
    ).rejects.toMatchObject({ code: 'clinician_busy' });
  });

  it('still blocks another clinician from that room at that hour', async () => {
    await makeRoom('Room 1');
    await book((await attendees(3)).map((c) => c.id));

    const other = await makeUser('therapist');
    const theirs = await makeClient(other.id);
    await expect(
      bookAppointment(actor(desk), {
        clientId: theirs.id, clinicianId: other.id, date: TUESDAY,
        startMinute: THREE_PM, type: 'standard', modality: 'in_person',
      }),
    ).rejects.toMatchObject({ code: 'no_room' });
  });

  it('moves the whole group to the next free room, never splitting it', async () => {
    await makeRoom('Room 1');
    await makeRoom('Room 2');
    const other = await makeUser('therapist');
    const theirs = await makeClient(other.id);
    const taken = await bookAppointment(actor(desk), {
      clientId: theirs.id, clinicianId: other.id, date: TUESDAY,
      startMinute: THREE_PM, type: 'standard', modality: 'in_person',
    });

    const group = await book((await attendees(3)).map((c) => c.id));
    const rooms = new Set(group.appointments.map((a) => a.roomId));
    expect(rooms.size).toBe(1);
    expect([...rooms][0]).not.toBe(taken.roomId);
  });

  it('books telehealth with no room at all', async () => {
    const group = await book((await attendees(3)).map((c) => c.id), { modality: 'telehealth' });
    expect(group.appointments.every((a) => a.roomId === null)).toBe(true);
  });

  it('refuses the whole booking when no room is free, leaving nothing behind', async () => {
    await makeRoom('Room 1');
    const other = await makeUser('therapist');
    const theirs = await makeClient(other.id);
    await bookAppointment(actor(desk), {
      clientId: theirs.id, clinicianId: other.id, date: TUESDAY,
      startMinute: THREE_PM, type: 'standard', modality: 'in_person',
    });

    await expect(book((await attendees(3)).map((c) => c.id))).rejects.toBeInstanceOf(Conflict);
    expect(await prisma.appointment.count()).toBe(1);
    expect(await prisma.groupSession.count()).toBe(0);
  });

  it('refuses a group with nobody in it', async () => {
    // An hour and a room held for no one. The guard exists; nothing asked it.
    await makeRoom('Room 1');
    await expect(book([])).rejects.toMatchObject({
      message: 'A group session needs at least one attendee',
    });
  });

  it('books a group of one, which is a group the practice can run', async () => {
    await makeRoom('Room 1');
    const [only] = await attendees(1);
    const group = await book([only!.id]);
    expect(group.appointments).toHaveLength(1);
  });

  it('takes each client once, however many times they are listed', async () => {
    await makeRoom('Room 1');
    const [a, b] = await attendees(2);
    const group = await book([a!.id, b!.id, a!.id]);
    expect(group.appointments).toHaveLength(2);
  });

  it('refuses an attendee who is not a client of this practice', async () => {
    await makeRoom('Room 1');
    const [a] = await attendees(1);
    await expect(book([a!.id, 'not-a-client'])).rejects.toMatchObject({ status: 404 });
  });
});

describe('attendance and notes are per attendee', () => {
  it('marks one attendee a no-show without touching the others', async () => {
    await makeRoom('Room 1');
    const group = await book((await attendees(3)).map((c) => c.id));
    const [absent, ...present] = group.appointments;

    await setStatus(actor(desk), absent!.id, 'no_show', { clock: fixedClock('2026-09-01T20:00:00Z') });

    const after = await getGroupSession(group.id);
    expect(after.appointments.find((a) => a.id === absent!.id)!.status).toBe('no_show');
    expect(present.every((p) => after.appointments.find((a) => a.id === p.id)!.status === 'scheduled')).toBe(true);
  });

  it('gives each attendee their own note, invisible on the others', async () => {
    await makeRoom('Room 1');
    const group = await book((await attendees(3)).map((c) => c.id));
    const [first, second] = group.appointments;

    const note = await createProgressNote(actor(clinician), {
      appointmentId: first!.id, content: 'Attended, participated in the exercise.',
    });

    const forFirst = await listProgressNotes(actor(clinician), first!.clientId);
    const forSecond = await listProgressNotes(actor(clinician), second!.clientId);
    expect(forFirst.map((n) => n.id)).toEqual([note.id]);
    expect(forSecond).toEqual([]);
  });

  it('keeps one attendee\'s note out of another attendee\'s record entirely', async () => {
    await makeRoom('Room 1');
    const group = await book((await attendees(2)).map((c) => c.id));
    const [first] = group.appointments;

    const note = await createProgressNote(actor(clinician), {
      appointmentId: first!.id, content: 'Private to this attendee.',
    });
    const read = await getProgressNote(actor(clinician), note.id);
    expect(read.clientId).toBe(first!.clientId);
  });

  it('logs one audit row per attendee, all naming their own client', async () => {
    await makeRoom('Room 1');
    const people = await attendees(4);
    await book(people.map((c) => c.id));

    const rows = await prisma.auditEvent.findMany({
      where: { actorId: desk.id, action: 'create', resource: 'appointment' },
    });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.clientId))).toEqual(new Set(people.map((c) => c.id)));
  });

  it('charges each attendee their own fee when the session completes', async () => {
    await makeRoom('Room 1');
    const clock = fixedClock('2026-09-01T20:00:00Z');
    const cheap = await makeClient(clinician.id, { feeCents: 5000 });
    const standard = await makeClient(clinician.id);
    const group = await book([cheap.id, standard.id]);

    for (const a of group.appointments) {
      await setStatus(actor(desk), a.id, 'arrived', { clock });
      await setStatus(actor(desk), a.id, 'in_session', { clock });
      await setStatus(actor(desk), a.id, 'completed', { clock });
    }

    const rows = await prisma.appointment.findMany({ select: { clientId: true, chargeFeeCents: true } });
    expect(rows.find((r) => r.clientId === cheap.id)!.chargeFeeCents).toBe(5000);
    expect(rows.find((r) => r.clientId === standard.id)!.chargeFeeCents).toBe(18000);
  });
});

describe('leaving and ending a group', () => {
  it('drops a rescheduled attendee out of the group', async () => {
    await makeRoom('Room 1');
    const group = await book((await attendees(3)).map((c) => c.id));
    const [moved] = group.appointments;

    await rescheduleAppointment(actor(desk), moved!.id, { date: TUESDAY, startMinute: 16 * 60 });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: moved!.id } });
    expect(row.groupSessionId).toBeNull();
    expect((await getGroupSession(group.id)).appointments).toHaveLength(2);
  });

  it('will not let two rescheduled attendees land on each other', async () => {
    await makeRoom('Room 1');
    const group = await book((await attendees(3)).map((c) => c.id));
    const [a, b] = group.appointments;

    await rescheduleAppointment(actor(desk), a!.id, { date: TUESDAY, startMinute: 16 * 60 });
    await expect(
      rescheduleAppointment(actor(desk), b!.id, { date: TUESDAY, startMinute: 16 * 60 }),
    ).rejects.toMatchObject({ code: 'clinician_busy' });
  });

  it('cancels every attendee, judging each against the late-cancel window', async () => {
    await makeRoom('Room 1');
    const group = await book((await attendees(3)).map((c) => c.id));

    // Well ahead of the session: an advance cancellation, no fee.
    const early = fixedClock(new Date(group.appointments[0]!.startAt.getTime() - 5 * DAY));
    const { cancelled } = await cancelGroupSession(actor(desk), group.id, {
      reason: 'clinician unwell', clock: early,
    });

    expect(cancelled).toHaveLength(3);
    const rows = await prisma.appointment.findMany();
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
    expect(rows.every((r) => r.chargeFeeCents === null)).toBe(true);
  });

  it('frees the room once the group is cancelled', async () => {
    await makeRoom('Room 1');
    const group = await book((await attendees(3)).map((c) => c.id));
    await cancelGroupSession(actor(desk), group.id, {
      clock: fixedClock(new Date(group.appointments[0]!.startAt.getTime() - 5 * DAY)),
    });

    const other = await makeUser('therapist');
    const theirs = await makeClient(other.id);
    await expect(
      bookAppointment(actor(desk), {
        clientId: theirs.id, clinicianId: other.id, date: TUESDAY,
        startMinute: THREE_PM, type: 'standard', modality: 'in_person',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('who may book a group', () => {
  it('refuses a role with no appointment permission at all', async () => {
    await makeRoom('Room 1');
    const auditor = await makeUser('auditor');
    const people = await attendees(2);
    await expect(
      bookGroupSession(actor(auditor), {
        clinicianId: clinician.id, clientIds: people.map((c) => c.id),
        date: TUESDAY, startMinute: THREE_PM,
      }),
    ).rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.appointment.count()).toBe(0);
    expect(await prisma.groupSession.count()).toBe(0);
  });
});
