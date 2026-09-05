import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, fixedClock } from '../clock';
import { prisma } from '../db';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from './booking';
import { runReminderHorizon } from './reminders';

/** 2026-09-01 15:00 America/New_York, as everywhere else in this suite. */
const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;
const START = new Date('2026-09-01T19:00:00Z');

let desk: Awaited<ReturnType<typeof makeUser>>;
let therapist: Awaited<ReturnType<typeof makeUser>>;

async function clinicianWorkingTuesdays() {
  const u = await makeUser('therapist');
  await prisma.availability.create({ data: { userId: u.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
  return u;
}

/**
 * Book the standing Tuesday 3pm, then backdate `createdAt` so the booking has
 * the notice the test wants. `createdAt` is what decides which stages were ever
 * sendable, and Prisma's default writes wall time.
 */
async function appointmentBooked(msBeforeStart: number, clientOpts: { email?: string | null; phone?: string | null; reminderPreference?: 'email' | 'sms' | 'none' } = {}) {
  const client = await makeClient(therapist.id);
  await prisma.client.update({
    where: { id: client.id },
    data: { email: 'tc@example.test', phone: '555-0100', ...clientOpts },
  });
  const appt = await bookAppointment(actor(desk), {
    clientId: client.id, clinicianId: therapist.id, date: TUESDAY, startMinute: THREE_PM,
    type: 'standard', modality: 'in_person',
  });
  return prisma.appointment.update({
    where: { id: appt.id },
    data: { createdAt: new Date(START.getTime() - msBeforeStart) },
  });
}

const stagesFor = async (id: string) =>
  (await prisma.appointmentReminder.findMany({ where: { appointmentId: id }, orderBy: { dueAt: 'asc' } }))
    .map((r) => r.stage);

beforeEach(async () => {
  await resetDb();
  await settings();
  await makeRoom('Room 1');
  desk = await makeUser('front_desk');
  therapist = await clinicianWorkingTuesdays();
});
afterAll(() => prisma.$disconnect());

describe('runReminderHorizon — idempotent across runs', () => {
  it('running twice over the same window queues nothing the second time', async () => {
    const appt = await appointmentBooked(30 * DAY);
    const clock = fixedClock(new Date(START.getTime() - 12 * HOUR));

    const first = await runReminderHorizon(clock);
    expect(first.queued.map((q) => q.stage)).toEqual(['d5', 'd1']); // both behind us; d0 is not
    expect(first.promoted).toEqual([appt.id]);

    const second = await runReminderHorizon(clock);
    expect(second.queued).toEqual([]);
    expect(second.promoted).toEqual([]);

    expect(await prisma.appointmentReminder.count()).toBe(2);
    expect(await prisma.outboxMessage.count({ where: { templateKey: 'appointment_reminder' } })).toBe(2);
  });

  it('gives every reminder an outbox row, which is what the fee rests on', async () => {
    await appointmentBooked(30 * DAY);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 4 * DAY)));

    const reminders = await prisma.appointmentReminder.findMany();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.outboxMessageId).not.toBeNull();
    expect(reminders[0]!.sentAt).not.toBeNull();
  });
});

describe('what a late booking can still be asked', () => {
  it('booked 2 days out skips d5 and still gets d1 and d0', async () => {
    const appt = await appointmentBooked(2 * DAY);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));

    expect(await stagesFor(appt.id)).toEqual(['d1', 'd0']);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation).toBe('pending');
  });

  it('booked 6 hours out gets d0 only, and is still fee-eligible', async () => {
    const appt = await appointmentBooked(6 * HOUR);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));

    expect(await stagesFor(appt.id)).toEqual(['d0']);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation).toBe('pending');
  });

  it('booked inside the day-of lead is never promoted, so it can never be charged', async () => {
    const appt = await appointmentBooked(2 * HOUR);
    const run = await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));

    expect(run.queued).toEqual([]);
    expect(await stagesFor(appt.id)).toEqual([]);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation).toBe('not_required');
  });
});

describe('the whole cadence, in under a second of wall time', () => {
  it('walks one appointment from booking to the last stage and queues exactly 3 messages', async () => {
    const appt = await appointmentBooked(30 * DAY);
    const clock = fixedClock(new Date(START.getTime() - 30 * DAY));

    expect((await runReminderHorizon(clock)).queued).toEqual([]); // nothing due yet

    clock.set(new Date(START.getTime() - 5 * DAY));
    expect((await runReminderHorizon(clock)).queued.map((q) => q.stage)).toEqual(['d5']);

    clock.set(new Date(START.getTime() - DAY));
    expect((await runReminderHorizon(clock)).queued.map((q) => q.stage)).toEqual(['d1']);

    clock.set(new Date(START.getTime() - 3 * HOUR));
    expect((await runReminderHorizon(clock)).queued.map((q) => q.stage)).toEqual(['d0']);

    clock.set(new Date(START.getTime() - 10 * 60_000));
    expect((await runReminderHorizon(clock)).queued).toEqual([]);

    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1', 'd0']);
    expect(await prisma.outboxMessage.count({ where: { templateKey: 'appointment_reminder' } })).toBe(3);
  });
});

describe('appointments the practice stops asking about', () => {
  const atDayBefore = () => fixedClock(new Date(START.getTime() - DAY));

  it.each(['cancelled', 'late_cancelled'] as const)('queues no further stages once %s', async (status) => {
    const appt = await appointmentBooked(30 * DAY);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)));
    await prisma.appointment.update({ where: { id: appt.id }, data: { status } });

    expect((await runReminderHorizon(atDayBefore())).queued).toEqual([]);
    expect(await stagesFor(appt.id)).toEqual(['d5']);
  });

  it.each(['confirmed', 'declined'] as const)('queues no further stages once the client has %s', async (confirmation) => {
    const appt = await appointmentBooked(30 * DAY);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)));
    await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation } });

    expect((await runReminderHorizon(atDayBefore())).queued).toEqual([]);
    expect(await stagesFor(appt.id)).toEqual(['d5']);
  });
});

describe('the safety setting is not allowed to become a billing trap', () => {
  const atFiveDays = () => fixedClock(new Date(START.getTime() - 5 * DAY));

  it('never asks a client whose preference is none', async () => {
    const appt = await appointmentBooked(30 * DAY, { reminderPreference: 'none' });
    const run = await runReminderHorizon(atFiveDays());

    expect(run.queued).toEqual([]);
    expect(await stagesFor(appt.id)).toEqual([]);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation).toBe('not_required');
  });

  it('never asks a client whose chosen channel has no address', async () => {
    const appt = await appointmentBooked(30 * DAY, { reminderPreference: 'sms', phone: null });
    expect((await runReminderHorizon(atFiveDays())).queued).toEqual([]);
    expect(await stagesFor(appt.id)).toEqual([]);
  });

  it('switching to none mid-cadence stops the rest and returns pending to not_required', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await runReminderHorizon(atFiveDays());
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation).toBe('pending');

    await prisma.client.update({ where: { id: appt.clientId }, data: { reminderPreference: 'none' } });
    const run = await runReminderHorizon(fixedClock(new Date(START.getTime() - DAY)));

    expect(run.exempted).toEqual([appt.id]);
    expect(await stagesFor(appt.id)).toEqual(['d5']);
    // The sweep in P0-5 reads `pending`. This row is out of its reach for good.
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation).toBe('not_required');
  });
});

describe('the audit trail', () => {
  it('logs the cadence as the system actor, in the same transaction as the write', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)));

    const rows = await prisma.auditEvent.findMany({
      where: { actorId: 'system', resourceId: appt.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'update', resource: 'appointment', allowed: true, clientId: appt.clientId });
  });
});

describe('the reminder body', () => {
  it('says when, and never why', async () => {
    await appointmentBooked(30 * DAY);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)));

    const msg = await prisma.outboxMessage.findFirstOrThrow({ where: { templateKey: 'appointment_reminder' } });
    expect(msg.body).toBe('Appointment reminder: Tuesday 15:00, Stillwater. Reply to this message to change it.');
  });
});
