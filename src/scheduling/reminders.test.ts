import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, fixedClock } from '../clock';
import { prisma } from '../db';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from './booking';
import { indiscreetTerms } from '../messaging/outbox';
import { runReminderHorizon } from './reminders';
import type { Confirmation } from './confirmation';

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
async function appointmentBooked(msBeforeStart: number, clientOpts: { email?: string | null; phone?: string | null; reminderPreference?: 'email' | 'sms' | 'none'; reminderStages?: ('d5' | 'd1' | 'd0')[] } = {}) {
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
  it('says when, carries the door, and never says why', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)));

    const link = await prisma.portalLink.findFirstOrThrow({ where: { clientId: appt.clientId } });
    const msg = await prisma.outboxMessage.findFirstOrThrow({ where: { templateKey: 'appointment_reminder' } });
    expect(msg.body).toBe(
      `Appointment reminder: Tuesday 15:00, Stillwater. Please let us know if you are coming: http://localhost:3700/p/${link.token}. The link is personal to you — please do not forward it.`,
    );
    expect(indiscreetTerms(msg.body)).toEqual([]);
  });

  it('reuses the client\'s live door rather than minting one per stage', async () => {
    const appt = await appointmentBooked(30 * DAY);
    // Two stages queue in one run; a third a day later.
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 20 * HOUR)));
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 2 * HOUR)));

    expect(await prisma.appointmentReminder.count({ where: { appointmentId: appt.id } })).toBe(3);
    expect(await prisma.portalLink.count({ where: { clientId: appt.clientId } })).toBe(1);

    const link = await prisma.portalLink.findFirstOrThrow({ where: { clientId: appt.clientId } });
    const bodies = (await prisma.outboxMessage.findMany({ where: { templateKey: 'appointment_reminder' } }))
      .map((m) => m.body);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).toContain(`/p/${link.token}`);
  });
});

/**
 * P1-2, and Risk 2. A weekly client on the full cadence receives three messages
 * a week forever — ~11,000 a year across seventy of them — and the failure mode
 * is not the cost. It is the reminder becoming wallpaper, which degrades the
 * one signal the no-show fee is derived from.
 */
describe('the cadence cap on a client who always answers', () => {
  const clock = fixedClock(new Date(START.getTime() - 12 * HOUR));

  /**
   * A session that has already been and gone, with the answer the client gave.
   * Written directly: the point is the track record the horizon reads, not the
   * booking path that produced it. Telehealth so it needs no room.
   */
  const pastSession = (clientId: string, date: string, confirmation: Confirmation) =>
    prisma.appointment.create({
      data: {
        clientId, clinicianId: therapist.id, modality: 'telehealth',
        startAt: new Date(`${date}T19:00:00Z`), endAt: new Date(`${date}T19:50:00Z`),
        status: 'completed', confirmation,
      },
    });

  /** Four Tuesdays, oldest first. */
  const FOUR_WEEKS = ['2026-08-04', '2026-08-11', '2026-08-18', '2026-08-25'];

  const withHistory = async (answers: Confirmation[]) => {
    const appt = await appointmentBooked(30 * DAY);
    for (const [i, answer] of answers.entries()) {
      await pastSession(appt.clientId, FOUR_WEEKS[i]!, answer);
    }
    return appt;
  };

  const confirmedTimes = (n: number): Confirmation[] => Array.from({ length: n }, () => 'confirmed');

  it('asks four-from-four once, the day before, and not five days out', async () => {
    const appt = await withHistory(confirmedTimes(4));

    expect((await runReminderHorizon(clock)).queued.map((q) => q.stage)).toEqual(['d1']);
    expect(await stagesFor(appt.id)).toEqual(['d1']);
  });

  it('leaves three-from-four on the full cadence', async () => {
    const appt = await withHistory(confirmedTimes(3));
    expect(await runReminderHorizon(clock).then((r) => r.queued.map((q) => q.stage))).toEqual(['d5', 'd1']);
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1']);
  });

  /**
   * The invariant the cap must not break. Fewer messages is still a message, so
   * the row is still promoted to `pending` and there is still an outbox row
   * behind it — a capped client can be charged for silence on exactly the same
   * evidence as anybody else, because the evidence is what the cap did not touch.
   */
  it('still promotes to pending, so silence still has a sent message behind it', async () => {
    const appt = await withHistory(confirmedTimes(4));
    await runReminderHorizon(clock);

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.confirmation).toBe('pending');
    expect(await prisma.outboxMessage.count({ where: { clientId: appt.clientId } })).toBe(1);
  });

  it('restores the full cadence after a missed message', async () => {
    const appt = await withHistory([...confirmedTimes(3), 'no_response']);
    await runReminderHorizon(clock);
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1']);
  });

  it('restores it after a decline too — a streak is answering, not agreeing', async () => {
    const appt = await withHistory([...confirmedTimes(3), 'declined']);
    await runReminderHorizon(clock);
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1']);
  });

  /**
   * A sequence that would fool a total: nine confirmations, and a miss last
   * week. Nine is not four in a row, and the client who has just started
   * drifting is precisely who the five-day message exists for.
   */
  it('counts consecutively from the most recent, never in total', async () => {
    const appt = await withHistory(['confirmed', 'confirmed', 'no_response', 'confirmed']);
    await runReminderHorizon(clock);
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1']);
  });

  it('is off at a cap of zero, with no second flag to keep in sync', async () => {
    await settings({ confirmationStreakCap: 0 });
    const appt = await withHistory(confirmedTimes(4));
    await runReminderHorizon(clock);
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1']);
  });
});

describe('the stages a client picked for themselves', () => {
  /** Twelve hours out: `d5` and `d1` are due, `d0` is three hours away and is not. */
  const clock = fixedClock(new Date(START.getTime() - 12 * HOUR));

  const pastSession = (clientId: string, date: string, confirmation: Confirmation) =>
    prisma.appointment.create({
      data: {
        clientId, clinicianId: therapist.id, modality: 'telehealth',
        startAt: new Date(`${date}T19:00:00Z`), endAt: new Date(`${date}T19:50:00Z`),
        status: 'completed', confirmation,
      },
    });

  it('asks a five-days-only client five days out, and never again', async () => {
    const appt = await appointmentBooked(30 * DAY, { reminderStages: ['d5'] });
    await runReminderHorizon(clock);
    expect(await stagesFor(appt.id)).toEqual(['d5']);
  });

  /**
   * The whole point of the field, and the case the PRD names: one nudge, on the
   * day. Twelve hours out there is nothing to send yet — the selection narrows
   * the cadence, it does not move a message earlier.
   */
  it('sends a day-of-only client nothing until the day-of lead', async () => {
    const appt = await appointmentBooked(30 * DAY, { reminderStages: ['d0'] });
    await runReminderHorizon(clock);
    expect(await stagesFor(appt.id)).toEqual([]);

    await runReminderHorizon(fixedClock(new Date(START.getTime() - 2 * HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d0']);
  });

  /**
   * Stacking the two reductions is how a preference for *fewer* messages
   * becomes none, four confirmations after somebody ticked the box. The
   * selection wins outright, and the client still gets their one message.
   */
  it('is not narrowed further by a streak that would otherwise cap them', async () => {
    const appt = await appointmentBooked(30 * DAY, { reminderStages: ['d5'] });
    for (const date of ['2026-08-04', '2026-08-11', '2026-08-18', '2026-08-25']) {
      await pastSession(appt.clientId, date, 'confirmed');
    }
    await runReminderHorizon(clock);
    expect(await stagesFor(appt.id)).toEqual(['d5']);
  });

  /**
   * Fewer messages is still a message. A selection can take the promotion to
   * `pending` away by queuing nothing, but where it queues something the
   * evidence behind a later fee is exactly what it is for anybody else.
   */
  it('still promotes to pending, with an outbox row behind it', async () => {
    const appt = await appointmentBooked(30 * DAY, { reminderStages: ['d1'] });
    await runReminderHorizon(clock);

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.confirmation).toBe('pending');
    expect(await prisma.outboxMessage.count({ where: { clientId: appt.clientId } })).toBe(1);
  });

  /** `none` still outranks it: a selection is which stages, never whether. */
  it('never overrides the do-not-message setting', async () => {
    const appt = await appointmentBooked(30 * DAY, { reminderPreference: 'none', reminderStages: ['d1'] });
    await runReminderHorizon(clock);
    expect(await stagesFor(appt.id)).toEqual([]);
    expect(await prisma.outboxMessage.count({ where: { clientId: appt.clientId } })).toBe(0);
  });
});
