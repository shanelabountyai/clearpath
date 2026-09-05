import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, fixedClock } from '../clock';
import { prisma } from '../db';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from './booking';
import { bookGroupSession } from './groups';
import { setStatus, type Status } from './lifecycle';
import { runReminderHorizon } from './reminders';
import { sweepAt, runNonResponseSweep, type SweepAction } from './nonresponse';
import type { Confirmation } from './confirmation';

/** 2026-09-01 15:00 America/New_York, as everywhere else in this suite. */
const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;
const START = new Date('2026-09-01T19:00:00Z');

/**
 * P0-5, decided before anything persists. The whole feature's defensibility is
 * one truth table: which (`status` × `confirmation`) pairs the sweep may act
 * on, and which it may only observe.
 */
describe('what silence means (pure)', () => {
  const STATUSES: Status[] = [
    'scheduled', 'confirmed', 'arrived', 'in_session', 'completed', 'no_show',
    'cancelled', 'late_cancelled',
  ];
  const CONFIRMATIONS: Confirmation[] = [
    'not_required', 'pending', 'confirmed', 'declined', 'no_response',
  ];

  const decide = (status: Status, confirmation: Confirmation, auto = true): SweepAction =>
    sweepAt({ status, confirmation }, { autoNoShowOnNoResponse: auto });

  it('acts on nothing that is not still waiting for an answer', () => {
    for (const status of STATUSES) {
      for (const confirmation of CONFIRMATIONS.filter((c) => c !== 'pending')) {
        expect(decide(status, confirmation), `${status}/${confirmation}`).toBe('nothing');
      }
    }
  });

  it('does nothing at all where the practice never asked', () => {
    for (const status of STATUSES) {
      expect(decide(status, 'not_required')).toBe('nothing');
    }
  });

  it('records the silence whatever else happened', () => {
    for (const status of ['confirmed', 'arrived', 'in_session', 'completed'] as Status[]) {
      expect(decide(status, 'pending'), status).toBe('record');
    }
  });

  it('marks a no-show only from scheduled — a check-in always wins', () => {
    expect(decide('scheduled', 'pending')).toBe('no_show');
    for (const status of ['confirmed', 'arrived', 'in_session', 'completed'] as Status[]) {
      expect(decide(status, 'pending'), status).not.toBe('no_show');
    }
  });

  it('leaves an hour nobody is coming to alone', () => {
    // A session front desk cancelled after the cadence started. The question
    // was withdrawn with the hour; "they never answered" is true and useless,
    // and the row must never reach the money branch.
    for (const status of ['cancelled', 'late_cancelled'] as Status[]) {
      expect(decide(status, 'pending'), status).toBe('nothing');
    }
  });

  /**
   * D-10. The flag governs `status` and money and nothing else. Recording that
   * the client never answered is the evidence, and evidence is not optional —
   * turning the policy off must leave the practice with the fact and the work
   * list, which is the whole feature minus the charge.
   */
  it('with the policy off, still records the silence and never acts on it', () => {
    expect(decide('scheduled', 'pending', false)).toBe('record');
    for (const status of STATUSES) {
      expect(decide(status, 'pending', false), status).not.toBe('no_show');
    }
  });
});

describe('against the database', () => {
  let desk: Awaited<ReturnType<typeof makeUser>>;
  let therapist: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await settings();
    await makeRoom('Room 1');
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
    await prisma.availability.create({
      data: { userId: therapist.id, weekday: 2, startMinute: 540, endMinute: 1020 },
    });
  });
  afterAll(() => prisma.$disconnect());

  /**
   * The only way into `pending` is the cadence, so the fixture takes the real
   * road: book with 30 days' notice, run the horizon, arrive at the sweep with
   * reminder rows and outbox rows behind the row — which is what the fee rests
   * on and what a hand-written `confirmation: 'pending'` would quietly skip.
   */
  async function asked(
    opts: { startMinute?: number; reminderPreference?: 'email' | 'sms' | 'none' } = {},
  ) {
    const client = await makeClient(therapist.id);
    await prisma.client.update({
      where: { id: client.id },
      data: { email: 'tc@example.test', phone: '555-0100', ...opts.reminderPreference ? { reminderPreference: opts.reminderPreference } : {} },
    });
    const appt = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: TUESDAY,
      startMinute: opts.startMinute ?? THREE_PM, type: 'standard', modality: 'in_person',
      clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });
    await runReminderHorizon(fixedClock(new Date(appt.startAt.getTime() - 2 * HOUR)));
    return prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
  }

  const row = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });
  /** 20 minutes past the start, which is the sweep's moment. */
  const afterGrace = (appt: { startAt: Date }) =>
    fixedClock(new Date(appt.startAt.getTime() + 20 * 60_000));

  it('charges the silent absence, as one write with its audit row', async () => {
    const appt = await asked();
    expect(appt.confirmation).toBe('pending');

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.noResponse).toEqual([appt.id]);
    expect(run.noShow).toEqual([appt.id]);

    const after = await row(appt.id);
    expect(after.status).toBe('no_show');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBe(9000);
  });

  /**
   * The indefensible case, asserted directly. This row is what the whole
   * feature is judged on: the client never answered a message, and then walked
   * in. Confirmation and attendance were never the same field, so the sweep
   * records the first and cannot touch the second.
   */
  it('does not charge a client who said nothing and turned up', async () => {
    const appt = await asked();
    await setStatus(actor(desk), appt.id, 'arrived');

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.noResponse).toEqual([appt.id]);
    expect(run.noShow).toEqual([]);

    const after = await row(appt.id);
    expect(after.status).toBe('arrived');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBeNull();
  });

  it('cannot reach a client who is mid-session', async () => {
    const appt = await asked();
    await setStatus(actor(desk), appt.id, 'arrived');
    await setStatus(actor(desk), appt.id, 'in_session');

    await runNonResponseSweep(afterGrace(appt));
    const after = await row(appt.id);
    expect(after.status).toBe('in_session');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBeNull();
  });

  it('waits out the grace period rather than charging on the hour', async () => {
    const appt = await asked();

    const early = await runNonResponseSweep(fixedClock(new Date(appt.startAt.getTime() + 19 * 60_000)));
    expect(early.noResponse).toEqual([]);
    expect((await row(appt.id)).confirmation).toBe('pending');

    await runNonResponseSweep(afterGrace(appt));
    expect((await row(appt.id)).confirmation).toBe('no_response');
  });

  it('is idempotent: a second sweep finds nothing left to decide', async () => {
    const appt = await asked();
    await runNonResponseSweep(afterGrace(appt));

    const second = await runNonResponseSweep(afterGrace(appt));
    expect(second).toEqual({ noResponse: [], noShow: [], exempted: [] });
    expect(await prisma.appointment.count({ where: { status: 'no_show' } })).toBe(1);
  });

  it('leaves an answered appointment alone', async () => {
    const confirmed = await asked({ startMinute: THREE_PM });
    await prisma.appointment.update({
      where: { id: confirmed.id }, data: { confirmation: 'confirmed' },
    });

    const run = await runNonResponseSweep(afterGrace(confirmed));
    expect(run).toEqual({ noResponse: [], noShow: [], exempted: [] });
    expect((await row(confirmed.id)).status).toBe('scheduled');
  });

  /**
   * D-10 against the database. With the flag off the practice keeps the
   * evidence and loses the charge — a one-row change, not a code change.
   */
  it('records but does not charge with the policy off', async () => {
    await settings({ autoNoShowOnNoResponse: false });
    const appt = await asked();

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.noResponse).toEqual([appt.id]);
    expect(run.noShow).toEqual([]);

    const after = await row(appt.id);
    expect(after.status).toBe('scheduled');
    expect(after.confirmation).toBe('no_response');
    expect(after.chargeFeeCents).toBeNull();
  });

  /**
   * P0-2, re-checked at the moment of the fee rather than only before the first
   * send. A client who moved to `none` after the cadence started is not a
   * client the practice may charge for silence, whichever job gets there first.
   */
  it('re-checks eligibility before the money, not only before the sends', async () => {
    const appt = await asked();
    await prisma.client.update({
      where: { id: appt.clientId }, data: { reminderPreference: 'none' },
    });

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.exempted).toEqual([appt.id]);
    expect(run.noResponse).toEqual([]);

    const after = await row(appt.id);
    expect(after.status).toBe('scheduled');
    expect(after.confirmation).toBe('not_required');
    expect(after.chargeFeeCents).toBeNull();
  });

  it('will not charge for silence it cannot prove it asked about', async () => {
    const appt = await asked();
    // The evidence, deleted underneath the row. Unreachable by design — only
    // the cadence promotes to `pending`, and only when it queued something —
    // so this asserts what happens if that ever stops being true.
    await prisma.appointmentReminder.deleteMany({ where: { appointmentId: appt.id } });

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.exempted).toEqual([appt.id]);
    expect((await row(appt.id)).confirmation).toBe('not_required');
    expect((await row(appt.id)).chargeFeeCents).toBeNull();
  });

  it('attributes the charge to the system, not to a person and not to the client', async () => {
    const appt = await asked();
    await runNonResponseSweep(afterGrace(appt));

    const rows = await prisma.auditEvent.findMany({
      where: { resourceId: appt.id, actorId: 'system' },
      orderBy: { at: 'asc' },
    });
    // One from the cadence's promotion, one from the sweep's determination.
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({
      action: 'update', resource: 'appointment', actorRole: 'admin',
      allowed: true, clientId: appt.clientId, breakGlass: false,
    });
    expect(await prisma.auditEvent.count({ where: { resourceId: appt.id, actorRole: 'client' } })).toBe(0);
  });

  it('carries no client name, phone or email into the trail', async () => {
    const appt = await asked();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: appt.clientId } });
    await runNonResponseSweep(afterGrace(appt));

    const trail = JSON.stringify(await prisma.auditEvent.findMany({ where: { clientId: appt.clientId } }));
    for (const secret of [client.firstName, client.lastName, client.email!, client.phone!]) {
      expect(trail).not.toContain(secret);
    }
  });

  /**
   * P0-8. Attendees are evaluated one at a time, because a group session is N
   * appointments sharing a key rather than one appointment with N clients.
   */
  it('evaluates group attendees independently — 5 attendees, 2 silent, 2 rows', async () => {
    const clientIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await makeClient(therapist.id);
      await prisma.client.update({ where: { id: c.id }, data: { email: `g${i}@example.test` } });
      clientIds.push(c.id);
    }
    await bookGroupSession(actor(desk), {
      clinicianId: therapist.id, clientIds, date: TUESDAY, startMinute: 11 * 60,
      topic: 'Tuesday skills group', clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 6 * HOUR)));

    const attendees = await prisma.appointment.findMany({
      where: { groupSessionId: { not: null } }, orderBy: { clientId: 'asc' },
    });
    expect(attendees).toHaveLength(5);
    for (const a of attendees) expect(a.confirmation).toBe('pending');

    // Three answer; two say nothing.
    for (const a of attendees.slice(0, 3)) {
      await prisma.appointment.update({ where: { id: a.id }, data: { confirmation: 'confirmed' } });
    }

    const run = await runNonResponseSweep(fixedClock(new Date(START.getTime() - 3 * HOUR)));
    expect(run.noResponse.sort()).toEqual(attendees.slice(3).map((a) => a.id).sort());
    expect(await prisma.appointment.count({ where: { confirmation: 'no_response' } })).toBe(2);
    // The three who answered keep their hour, and so does the group.
    expect(await prisma.appointment.count({ where: { status: 'scheduled' } })).toBe(3);
  });
});
