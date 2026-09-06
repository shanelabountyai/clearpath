import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, fixedClock } from '../clock';
import { prisma } from '../db';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from './booking';
import { bookGroupSession } from './groups';
import { setStatus } from './lifecycle';
import { runNonResponseSweep } from './nonresponse';
import { runReminderHorizon } from './reminders';

/** 2026-09-01 15:00 America/New_York, as everywhere else in this suite. */
const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;
const START = new Date('2026-09-01T19:00:00Z');
const MINUTE = 60_000;

let desk: Awaited<ReturnType<typeof makeUser>>;
let therapist: Awaited<ReturnType<typeof makeUser>>;

/** Grace has passed and then some: the sweep's own moment. */
const afterGrace = () => fixedClock(new Date(START.getTime() + 25 * MINUTE));

async function reachableClient(overrides: Record<string, unknown> = {}) {
  const client = await makeClient(therapist.id);
  return prisma.client.update({
    where: { id: client.id },
    data: { email: 'tc@example.test', phone: '555-0100', ...overrides },
  });
}

/**
 * An appointment the cadence has already asked about — `pending` is only
 * reachable through `runReminderHorizon`, and reaching it is what proves the
 * practice asked. The tests set it directly so each one is about the sweep.
 */
async function asked(opts: { startMinute?: number; clientId?: string } = {}) {
  const clientId = opts.clientId ?? (await reachableClient()).id;
  const appt = await bookAppointment(actor(desk), {
    clientId, clinicianId: therapist.id, date: TUESDAY,
    startMinute: opts.startMinute ?? THREE_PM, type: 'standard', modality: 'in_person',
  });
  return prisma.appointment.update({
    where: { id: appt.id },
    // Backdated for the same reason `reminders.test.ts` backdates it: `createdAt`
    // is the notice the booking had, Prisma's default writes wall time, and a
    // booking with negative notice was never one the practice could ask about.
    data: { confirmation: 'pending', createdAt: new Date(START.getTime() - 30 * DAY) },
  });
}

const reload = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetDb();
  await settings({ noShowFeeCents: 9000, lateCancelFeeCents: 9000, standardFeeCents: 18000, graceMinutes: 20 });
  await makeRoom('Room 1');
  desk = await makeUser('front_desk');
  therapist = await makeUser('therapist');
  await prisma.availability.create({ data: { userId: therapist.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
});
afterAll(() => prisma.$disconnect());

describe('the sweep records silence', () => {
  it('waits for the grace period', async () => {
    const appt = await asked();
    const tooEarly = fixedClock(new Date(START.getTime() + 15 * MINUTE));

    expect((await runNonResponseSweep(tooEarly)).recorded).toEqual([]);
    expect((await reload(appt.id)).confirmation).toBe('pending');

    expect((await runNonResponseSweep(afterGrace())).recorded).toEqual([appt.id]);
  });

  it('leaves `not_required` alone entirely', async () => {
    const client = await reachableClient({ reminderPreference: 'none' });
    const appt = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: TUESDAY,
      startMinute: THREE_PM, type: 'standard', modality: 'in_person',
    });

    const out = await runNonResponseSweep(afterGrace());

    expect(out).toEqual({ recorded: [], noShowed: [] });
    const after = await reload(appt.id);
    expect(after.confirmation).toBe('not_required');
    expect(after.status).toBe('scheduled');
    expect(after.chargeFeeCents).toBeNull();
  });

  it('is idempotent — a second run has nothing left to say', async () => {
    await asked();
    const clock = afterGrace();

    expect((await runNonResponseSweep(clock)).recorded).toHaveLength(1);
    expect(await runNonResponseSweep(clock)).toEqual({ recorded: [], noShowed: [] });
  });
});

describe('the status transition, and the four times it must not happen', () => {
  it('marks a silent, untouched booking as a no-show and charges the no-show fee', async () => {
    const appt = await asked();

    const out = await runNonResponseSweep(afterGrace());

    expect(out.noShowed).toEqual([appt.id]);
    const after = await reload(appt.id);
    expect(after.status).toBe('no_show');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBe(9000);
  });

  /**
   * The row the whole feature is judged on. A client who never answered and
   * then walked in is `arrived` before the sweep runs, and the sweep is not
   * allowed to have an opinion about whether they were there.
   */
  it('does not charge a client who was checked in — the indefensible case', async () => {
    const appt = await asked();
    await setStatus(actor(desk), appt.id, 'arrived', {
      clock: fixedClock(new Date(START.getTime() - 5 * MINUTE)),
    });

    const out = await runNonResponseSweep(afterGrace());

    expect(out).toEqual({ recorded: [appt.id], noShowed: [] });
    const after = await reload(appt.id);
    expect(after.status).toBe('arrived');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBeNull();
  });

  it.each(['confirmed', 'in_session', 'completed'] as const)(
    'leaves a %s session where it is, and still records the silence',
    async (status) => {
      const appt = await asked();
      const clock = fixedClock(new Date(START.getTime() - 5 * MINUTE));
      const walk = { confirmed: ['confirmed'], in_session: ['arrived', 'in_session'], completed: ['arrived', 'in_session', 'completed'] } as const;
      for (const to of walk[status]) await setStatus(actor(desk), appt.id, to, { clock });

      await runNonResponseSweep(afterGrace());

      const after = await reload(appt.id);
      expect(after.status).toBe(status);
      expect(after.confirmation).toBe('no_response');
      // A completed session is charged the session fee by `setStatus`; nothing
      // the sweep did added to it.
      expect(after.chargeFeeCents).toBe(status === 'completed' ? 18000 : null);
    },
  );

  it('does not resurrect a cancelled hour into a no-show fee', async () => {
    const appt = await asked();
    await setStatus(actor(desk), appt.id, 'cancelled', {
      clock: fixedClock(new Date(START.getTime() - 48 * HOUR)),
    });

    const out = await runNonResponseSweep(afterGrace());

    expect(out.noShowed).toEqual([]);
    const after = await reload(appt.id);
    expect(after.status).toBe('cancelled');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBeNull();
  });
});

describe('the flag governs the money and nothing else (D-10)', () => {
  it('records the silence and charges nothing with the flag off', async () => {
    await settings({ autoNoShowOnNoResponse: false });
    const appt = await asked();

    const out = await runNonResponseSweep(afterGrace());

    expect(out).toEqual({ recorded: [appt.id], noShowed: [] });
    const after = await reload(appt.id);
    expect(after.status).toBe('scheduled');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBeNull();
  });
});

/**
 * D-01, at the last moment it can still apply. The horizon only looks forward,
 * so a client who moved to `none` after their final reminder is never returned
 * to `not_required` by it — this sweep is the last thing standing between a
 * safety setting and a bill for needing it.
 */
describe('a client who became unreachable after the last reminder', () => {
  it.each([
    ['switched to none', { reminderPreference: 'none' as const }],
    ['lost the address their channel needs', { reminderPreference: 'email' as const, email: null }],
  ])('records the silence but never charges — %s', async (_label, change) => {
    const client = await reachableClient();
    const appt = await asked({ clientId: client.id });
    await prisma.client.update({ where: { id: client.id }, data: change });

    const out = await runNonResponseSweep(afterGrace());

    expect(out).toEqual({ recorded: [appt.id], noShowed: [] });
    const after = await reload(appt.id);
    expect(after.status).toBe('scheduled');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBeNull();
  });
});

describe('the trail (P0-9)', () => {
  it('names a system actor, not a person and not the client', async () => {
    const appt = await asked();
    await runNonResponseSweep(afterGrace());

    const rows = await prisma.auditEvent.findMany({ where: { resourceId: appt.id, actorId: 'system' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorRole: 'admin', action: 'update', resource: 'appointment',
      allowed: true, clientId: appt.clientId, reason: 'no_response',
    });
  });

  it('carries no name, phone or email — ids and codes only', async () => {
    const client = await reachableClient();
    await asked({ clientId: client.id });
    await runNonResponseSweep(afterGrace());

    const dump = JSON.stringify(await prisma.auditEvent.findMany());
    for (const secret of [client.firstName, client.lastName, 'tc@example.test', '555-0100']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('writes the status, the fee and the audit row in one transaction', async () => {
    const appt = await asked();
    await runNonResponseSweep(afterGrace());

    const [row] = await prisma.auditEvent.findMany({ where: { resourceId: appt.id, actorId: 'system' } });
    const after = await reload(appt.id);
    // The audit row cannot be older than the write it describes, because they
    // are the same commit.
    expect(row!.at.getTime()).toBeGreaterThanOrEqual(after.updatedAt.getTime() - 1000);
    expect(after.chargeFeeCents).toBe(9000);
  });
});

/**
 * P0-8. A group is N appointments sharing a key, so silence is per attendee and
 * so is the fee. Nothing about the group model changes.
 */
describe('group sessions are swept per attendee', () => {
  it('produces exactly one no_response per silent attendee', async () => {
    const clients = [];
    for (let i = 0; i < 5; i++) clients.push(await reachableClient());
    const group = await bookGroupSession(actor(desk), {
      clinicianId: therapist.id, clientIds: clients.map((c) => c.id),
      date: TUESDAY, startMinute: THREE_PM, topic: 'Tuesday skills group',
    });

    const silent = group.appointments.slice(0, 2);
    for (const a of group.appointments) {
      await prisma.appointment.update({
        where: { id: a.id },
        data: {
          confirmation: silent.includes(a) ? 'pending' : 'confirmed',
          createdAt: new Date(START.getTime() - 30 * DAY),
        },
      });
    }

    const out = await runNonResponseSweep(afterGrace());

    expect(out.recorded.sort()).toEqual(silent.map((a) => a.id).sort());
    expect(await prisma.appointment.count({ where: { confirmation: 'no_response' } })).toBe(2);
    expect(await prisma.appointment.count({ where: { status: 'no_show' } })).toBe(2);
    // The three who answered are untouched, including their money.
    expect(await prisma.appointment.count({ where: { status: 'scheduled', chargeFeeCents: null } })).toBe(3);
  });
});

/**
 * The capstone, in one spec. Three sends, no answer, one determination — and
 * the fee a human would have set, because the policy is about the fact and not
 * about who noticed it.
 */
describe('the whole loop, driven by the clock alone', () => {
  it('sends three times, is answered never, and charges once', async () => {
    const appt = await asked();
    // `asked()` sets `pending` directly; the cadence has to start from scratch.
    await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation: 'not_required' } });

    for (const at of [5 * DAY, DAY, 3 * HOUR]) {
      await runReminderHorizon(fixedClock(new Date(START.getTime() - at)));
    }
    expect(await prisma.appointmentReminder.count({ where: { appointmentId: appt.id } })).toBe(3);
    expect(await prisma.outboxMessage.count({ where: { clientId: appt.clientId } })).toBe(3);

    await runNonResponseSweep(afterGrace());

    const rows = await prisma.auditEvent.findMany({
      where: { resourceId: appt.id },
      orderBy: { at: 'asc' },
    });
    // Three sends and one determination, all by the system actor; the client
    // never answered, so there is no row saying they did.
    expect(rows.filter((r) => r.actorId === 'system')).toHaveLength(4);
    expect(rows.filter((r) => r.actorRole === 'client')).toHaveLength(0);
    expect(rows.filter((r) => r.reason === 'no_response')).toHaveLength(1);

    const after = await reload(appt.id);
    expect(after).toMatchObject({ status: 'no_show', confirmation: 'no_response', chargeFeeCents: 9000 });
  });

  it('charges the same whether a person or the sweep noticed', async () => {
    const swept = await asked();
    await runNonResponseSweep(afterGrace());

    const byHand = await asked({ startMinute: 16 * 60 });
    await setStatus(actor(desk), byHand.id, 'no_show');

    expect((await reload(swept.id)).chargeFeeCents).toBe((await reload(byHand.id)).chargeFeeCents);
  });
});

/**
 * The second structural lint, and the one with money attached.
 *
 * `no_response` is the only confirmation value a fee can be derived from, and
 * the only thing standing between it and a client who was never asked is
 * `confirmationRequired`. Every behavioural test above is about the sweep that
 * exists; this is about the one somebody writes next month — a batch job, an
 * admin button, a data fix — that sets `no_response` from a query of its own
 * and never consults the eligibility rule. Every test here would still pass,
 * because none of them call it. So the check is on the shape of the module:
 * write that value, and you name the function that decides who may be charged
 * for it.
 */
it('no path writes `no_response` without the eligibility rule beside it', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      const src = readFileSync(path, 'utf8');
      if (!/prisma\.|tx\./.test(src)) continue;
      if (!/confirmation:\s*['"`]no_response/.test(src)) continue;
      if (!src.includes('confirmationRequired')) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});
