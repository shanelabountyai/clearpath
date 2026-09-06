import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, fixedClock } from '../clock';
import { prisma } from '../db';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from './booking';
import { indiscreetTerms } from '../messaging/outbox';
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
 * Book the standing Tuesday 3pm, then backdate `bookedAt` so the booking has
 * the notice the test wants. `bookedAt` is what decides which stages were ever
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
    data: {
      createdAt: new Date(START.getTime() - msBeforeStart),
      bookedAt: new Date(START.getTime() - msBeforeStart),
    },
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

/**
 * P1-2 against the database. The pure rule is asserted in
 * `confirmation.test.ts`; what these prove is that the horizon reads a real
 * client's real history to decide it, rather than trusting a counter somebody
 * has to remember to keep right.
 */
describe('the cadence cap for standing clients', () => {
  /** Past sessions with answers already on them, newest last. */
  async function history(
    clientId: string,
    answers: ('confirmed' | 'declined' | 'no_response')[],
    opts: { weeksBack?: number } = {},
  ) {
    const oldest = (answers.length - 0 + 1 + (opts.weeksBack ?? 0)) * 7 * DAY;
    for (const [i, confirmation] of answers.entries()) {
      const at = new Date(START.getTime() - (oldest - i * 7 * DAY));
      await prisma.appointment.create({
        data: {
          clientId, clinicianId: therapist.id,
          // Weekly, walking backwards from a fortnight before the session.
          startAt: at,
          endAt: new Date(at.getTime() + 50 * 60_000),
          // Telehealth so the fixture needs no room: the check constraint
          // requires one for in-person, and these rows are only here for the
          // answer written on them.
          modality: 'telehealth',
          status: 'completed', confirmation,
          createdAt: new Date(START.getTime() - 120 * DAY),
          bookedAt: new Date(START.getTime() - 120 * DAY),
        },
      });
    }
  }

  it('drops a reliable client to the day-before message alone', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await history(appt.clientId, ['confirmed', 'confirmed', 'confirmed', 'confirmed']);

    // Five days out, where an uncapped client would already have had one.
    expect((await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)))).queued).toEqual([]);

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d1']);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation).toBe('pending');
  });

  it('restores the full cadence after a single miss', async () => {
    const appt = await appointmentBooked(30 * DAY);
    // Four confirmations and then, most recently, one silence.
    await history(appt.clientId, ['confirmed', 'confirmed', 'confirmed', 'confirmed', 'no_response']);

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1', 'd0']);
  });

  it('does not cap a client who has not answered often enough yet', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await history(appt.clientId, ['confirmed', 'confirmed', 'confirmed']);

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1', 'd0']);
  });

  it('counts only answers, never sessions nobody was asked about', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await history(appt.clientId, ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
    // Two later sessions the practice never asked about — a spell on
    // `reminderPreference: 'none'`, say. Silence there is not a miss, because
    // there was no question.
    await prisma.appointment.create({
      data: {
        clientId: appt.clientId, clinicianId: therapist.id,
        startAt: new Date(START.getTime() - 2 * DAY), endAt: new Date(START.getTime() - 2 * DAY + 50 * 60_000),
        modality: 'telehealth',
        status: 'completed', confirmation: 'not_required',
        createdAt: new Date(START.getTime() - 120 * DAY),
        bookedAt: new Date(START.getTime() - 120 * DAY),
      },
    });

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d1']);
  });

  it('is off at a cap of zero, and every client gets all three', async () => {
    await settings({ confirmationStreakCap: 0 });
    const appt = await appointmentBooked(30 * DAY);
    await history(appt.clientId, ['confirmed', 'confirmed', 'confirmed', 'confirmed']);

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1', 'd0']);
  });

  it('forgets a run of confirmations that has gone stale', async () => {
    const appt = await appointmentBooked(30 * DAY);
    // The same four confirmations, a year ago. A client who last confirmed
    // reliably last autumn is not a standing client with an earned cadence —
    // they are somebody coming back, and somebody coming back gets all three.
    await history(appt.clientId, ['confirmed', 'confirmed', 'confirmed', 'confirmed'], { weeksBack: 52 });

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1', 'd0']);
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

  /**
   * P2: the last named gap. A Spanish-speaking client got a reminder that was
   * neutral in a language they might not read, checked against a deny-list that
   * did not contain the word "terapia".
   */
  it('says the same thing in the language the client reads', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await prisma.client.update({ where: { id: appt.clientId }, data: { language: 'es' } });
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)));

    const link = await prisma.portalLink.findFirstOrThrow({ where: { clientId: appt.clientId } });
    const msg = await prisma.outboxMessage.findFirstOrThrow({ where: { templateKey: 'appointment_reminder' } });
    expect(msg.subject).toBe('Recordatorio de cita');
    expect(msg.body).toBe(
      `Recordatorio de cita: martes 15:00, Stillwater. Avísenos si va a venir: http://localhost:3700/p/${link.token}. El enlace es personal — por favor no lo reenvíe.`,
    );
    // The weekday is translated too. A Spanish body that says "Tuesday" is a
    // translation somebody stopped halfway through, and the day is the one
    // word in the message the client actually has to act on.
    expect(msg.body).not.toContain('Tuesday');
    expect(indiscreetTerms(msg.body)).toEqual([]);
  });

  it('asks a Spanish-speaking client exactly as it asks anybody else', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await prisma.client.update({ where: { id: appt.clientId }, data: { language: 'es' } });

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    // Same stages, same promotion, same fee-eligibility. A translated client is
    // not a lighter-touch client — the cadence does not know the difference.
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1', 'd0']);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation).toBe('pending');
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
 * P2-3 against the database. The pure rule lives in `confirmation.test.ts`;
 * what these prove is that the horizon reads the client's own stated cadence,
 * that a stated one is not overridden by an earned one, and — the part with
 * money attached — that choosing fewer messages does not buy an exemption from
 * the fee.
 */
describe('the cadence a client chose', () => {
  const setCadence = (clientId: string, reminderCadence: 'full' | 'day_before' | 'day_of') =>
    prisma.client.update({ where: { id: clientId }, data: { reminderCadence } });

  /** Past sessions carrying answers, newest last — enough to earn the cap. */
  async function confirmedRun(clientId: string, n: number) {
    for (let i = 0; i < n; i++) {
      const at = new Date(START.getTime() - (n + 1 - i) * 7 * DAY);
      await prisma.appointment.create({
        data: {
          clientId, clinicianId: therapist.id,
          startAt: at, endAt: new Date(at.getTime() + 50 * 60_000),
          modality: 'telehealth', status: 'completed', confirmation: 'confirmed',
          createdAt: new Date(START.getTime() - 120 * DAY),
          bookedAt: new Date(START.getTime() - 120 * DAY),
        },
      });
    }
  }

  it('sends a day-of client one message, on the day', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await setCadence(appt.clientId, 'day_of');

    // Five days out and a day out, where a full-cadence client would have had two.
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)));
    await runReminderHorizon(fixedClock(new Date(START.getTime() - DAY)));
    expect(await stagesFor(appt.id)).toEqual([]);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation)
      .toBe('not_required');

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d0']);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation)
      .toBe('pending');
  });

  it('sends a day-before client one message, the day before', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await setCadence(appt.clientId, 'day_before');

    await runReminderHorizon(fixedClock(new Date(START.getTime() - 5 * DAY)));
    expect(await stagesFor(appt.id)).toEqual([]);

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d1']);
  });

  it('leaves an unchosen cadence on all three stages', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d5', 'd1', 'd0']);
  });

  /**
   * The rule the whole item turns on. This client has confirmed four times
   * running, so the practice's inference says "day before" — and they have said
   * "day of". What they said wins.
   */
  it('does not let the earned cap override a cadence the client chose', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await confirmedRun(appt.clientId, 4);
    await setCadence(appt.clientId, 'day_of');

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(await stagesFor(appt.id)).toEqual(['d0']);
  });

  /**
   * And they are not reported as capped, because the cap did nothing to them.
   * A count that mixed "earned the shorter cadence" with "asked for one" would
   * mean two things and measure neither.
   */
  it('does not count a client who chose as a client who was capped', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await confirmedRun(appt.clientId, 4);
    await setCadence(appt.clientId, 'day_of');

    const run = await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(run.capped).toEqual([]);
    expect(run.queued.map((q) => q.stage)).toEqual(['d0']);
  });

  it('still caps a client who earned it and chose nothing', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await confirmedRun(appt.clientId, 4);

    const run = await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(run.capped).toEqual([appt.id]);
    expect(await stagesFor(appt.id)).toEqual(['d1']);
  });

  /**
   * The money. One delivered message is still asking, so a lighter cadence is
   * still fee-eligible — if it were not, the setting would be a way to opt out
   * of the policy and every client would find it.
   */
  it('leaves a lighter cadence fee-eligible: one message is still asking', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await setCadence(appt.clientId, 'day_of');

    await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation)
      .toBe('pending');
  });

  /**
   * And the invariant that keeps the fee honest, re-checked for a cadence with
   * one stage instead of three: booked closer in than their only message,
   * nothing queues, `pending` is never written, and the sweep can never reach
   * them. A lighter cadence narrows the window in which the practice may ask —
   * it does not create a way to charge for a message that was never sendable.
   */
  it('queues nothing, and promotes nothing, for a day-of client booked too late', async () => {
    const appt = await appointmentBooked(HOUR);
    await setCadence(appt.clientId, 'day_of');

    const run = await runReminderHorizon(fixedClock(new Date(START.getTime() - 30 * 60_000)));
    expect(run.queued).toEqual([]);
    expect(run.promoted).toEqual([]);
    expect(await stagesFor(appt.id)).toEqual([]);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation)
      .toBe('not_required');
  });

  /** `none` still wins over any cadence: it is a safety setting, not a volume one. */
  it('sends a day-of client on reminderPreference none nothing at all', async () => {
    const appt = await appointmentBooked(30 * DAY, { reminderPreference: 'none' });
    await setCadence(appt.clientId, 'day_of');

    const run = await runReminderHorizon(fixedClock(new Date(START.getTime() - HOUR)));
    expect(run.queued).toEqual([]);
    expect(await stagesFor(appt.id)).toEqual([]);
  });

  it('is idempotent for a one-stage cadence too', async () => {
    const appt = await appointmentBooked(30 * DAY);
    await setCadence(appt.clientId, 'day_of');
    const clock = fixedClock(new Date(START.getTime() - HOUR));

    await runReminderHorizon(clock);
    expect((await runReminderHorizon(clock)).queued).toEqual([]);
    expect(await prisma.appointmentReminder.count({ where: { appointmentId: appt.id } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: { templateKey: 'appointment_reminder' } })).toBe(1);
  });
});
