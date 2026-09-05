import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, fixedClock } from '../clock';
import { prisma } from '../db';
import { actor, deliverOutbox, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { assertsLiteral } from '../test/lint';
import { bookAppointment } from './booking';
import { bookGroupSession } from './groups';
import { setStatus, type Status } from './lifecycle';
import { dispatchOutbox, recordReceipt } from '../messaging/delivery';
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
   * road: book with 30 days' notice, run the horizon, hand the outbox to a
   * carrier and take its receipts — and arrive at the sweep with reminder rows,
   * outbox rows and *delivery* behind the row. All three are what the fee rests
   * on, and a hand-written `confirmation: 'pending'` would skip every one.
   *
   * `deliver: false` stops at the queue, which is the case P2 exists for: the
   * practice asked and nobody was reached.
   */
  async function asked(
    opts: { startMinute?: number; reminderPreference?: 'email' | 'sms' | 'none'; deliver?: boolean } = {},
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
    // The cadence's own timeline rather than a compressed one. This used to run
    // the horizon once, two hours out, and stamp every delivery an hour before
    // the session — which queued a "five days out" message five days late and
    // gave a client an hour to answer it. Harmless until P2-3, when the sweep
    // started asking how long before the hour the message actually arrived, at
    // which point the fixture was quietly describing a practice nobody runs.
    for (const lead of [5 * DAY, DAY, 3 * HOUR]) {
      const at = new Date(appt.startAt.getTime() - lead);
      await runReminderHorizon(fixedClock(at));
      if (opts.deliver !== false) await deliverOutbox(at);
    }
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
    expect(second).toEqual({ noResponse: [], noShow: [], exempted: [], undelivered: [], unanswerable: [] });
    expect(await prisma.appointment.count({ where: { status: 'no_show' } })).toBe(1);
  });

  it('leaves an answered appointment alone', async () => {
    const confirmed = await asked({ startMinute: THREE_PM });
    await prisma.appointment.update({
      where: { id: confirmed.id }, data: { confirmation: 'confirmed' },
    });

    const run = await runNonResponseSweep(afterGrace(confirmed));
    expect(run).toEqual({ noResponse: [], noShow: [], exempted: [], undelivered: [], unanswerable: [] });
    expect((await row(confirmed.id)).status).toBe('scheduled');
  });

  /**
   * P2, and the reason this phase exists. The practice queued three messages
   * and a carrier delivered none of them: a dead number, a bouncing mailbox, a
   * provider that was down for the six hours the cadence ran in. Every one of
   * those produces exactly the same evidence as a client ignoring you, which is
   * why charging on `queued` was never safe — the failure looks like the
   * offence, so nobody would ever have found out.
   */
  it('never charges a client the carrier could not reach', async () => {
    const appt = await asked({ deliver: false });
    expect(appt.confirmation).toBe('pending');

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.undelivered).toEqual([appt.id]);
    expect(run.exempted).toEqual([appt.id]);
    expect(run.noResponse).toEqual([]);
    expect(run.noShow).toEqual([]);

    const after = await row(appt.id);
    expect(after.status).toBe('scheduled');
    expect(after.chargeFeeCents).toBeNull();
  });

  /**
   * And it lands on `not_required`, not on `no_response`. `no_response` is a
   * statement about the client, and the client did not do anything — the
   * practice failed to reach them. Writing the stronger word would put "did not
   * answer" on the record of somebody who was never spoken to, which is the
   * same untruth as the fee minus the money.
   */
  it('records the failure as never having asked, not as the client staying silent', async () => {
    const appt = await asked({ deliver: false });
    await runNonResponseSweep(afterGrace(appt));
    expect((await row(appt.id)).confirmation).toBe('not_required');
  });

  /** The two exemptions must never blur: one is a rule, the other is a fault. */
  it('gives the delivery failure its own audit reason code', async () => {
    const appt = await asked({ deliver: false });
    await runNonResponseSweep(afterGrace(appt));

    const reasons = await prisma.auditEvent.findMany({
      where: { resourceId: appt.id }, select: { reason: true },
    });
    expect(reasons.map((r) => r.reason)).toContain('confirmation_undelivered');
    expect(reasons.map((r) => r.reason)).not.toContain('confirmation_not_required');
  });

  /**
   * `sent` is the old precondition wearing a better name. A carrier accepting a
   * message says nothing about whether anybody received it, and this is the
   * assertion that stops a future refactor from quietly treating the two as one.
   */
  it('is not satisfied by a carrier merely accepting the message', async () => {
    const appt = await asked({ deliver: false });
    await dispatchOutbox({
      clock: fixedClock(new Date(appt.startAt.getTime() - HOUR)),
      carrier: { name: 'accepts', send: async (m) => ({ providerRef: `r_${m.id}`, accepted: true }) },
    });
    expect(await prisma.outboxMessage.count({ where: { deliveryState: 'sent' } })).toBe(3);

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.undelivered).toEqual([appt.id]);
    expect((await row(appt.id)).chargeFeeCents).toBeNull();
  });

  /**
   * One delivered stage is enough, and that is a choice rather than a default.
   * Requiring all three would let a carrier hiccup on the day-of nudge erase a
   * `d5` message the client demonstrably received — stricter, but not more
   * honest, and it would hand the client a fee-free session for the provider's
   * bad afternoon rather than for anything either party did.
   */
  it('charges where one stage arrived and the rest did not', async () => {
    const appt = await asked({ deliver: false });
    // Three hours out rather than thirty minutes: since P2-3 an arrival has to
    // leave the client time to act on it, and this test is about one stage
    // arriving where the others failed — not about a message landing too late
    // to answer, which is its own exemption and has its own specs.
    const clock = fixedClock(new Date(appt.startAt.getTime() - 3 * HOUR));
    await dispatchOutbox({
      clock,
      carrier: { name: 'accepts', send: async (m) => ({ providerRef: `r_${m.id}`, accepted: true }) },
    });

    const [first, ...rest] = await prisma.outboxMessage.findMany({ orderBy: { createdAt: 'asc' } });
    const occurredAt = new Date(appt.startAt.getTime() - 3 * HOUR);
    await recordReceipt({ providerRef: first!.providerRef!, state: 'delivered', occurredAt });
    for (const m of rest) {
      await recordReceipt({ providerRef: m.providerRef!, state: 'failed', failureCode: 'unreachable', occurredAt });
    }

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.undelivered).toEqual([]);
    expect(run.noShow).toEqual([appt.id]);
    expect((await row(appt.id)).chargeFeeCents).toBe(9000);
  });

  /**
   * Eligibility is still checked first, and the order matters for the trail: a
   * client on `none` was never asked at all, so their exemption is the rule
   * rather than a delivery fault, and the audit row must not say otherwise.
   */
  it('still calls a never-asked client never-asked, not undelivered', async () => {
    const appt = await asked();
    await prisma.client.update({
      where: { id: appt.clientId }, data: { reminderPreference: 'none' },
    });

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.exempted).toEqual([appt.id]);
    expect(run.undelivered).toEqual([]);
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
    // Three from the cadence — one per run that queued a stage, on the real
    // five-day timeline — and one from the sweep's determination.
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)).toMatchObject({
      action: 'update', resource: 'appointment', actorRole: 'admin',
      allowed: true, clientId: appt.clientId, breakGlass: false,
    });
    expect(await prisma.auditEvent.count({ where: { resourceId: appt.id, actorRole: 'client' } })).toBe(0);
  });

  /**
   * P2-3. The delivery precondition's own argument, one step further along. The
   * practice reached them — but with an hour to spare, which is not a chance to
   * answer, it is a chance to be charged. Same landing as the undelivered case
   * and for the same reason: `no_response` is a statement about the client, and
   * a client who never had time to reply did not do anything.
   */
  it('never charges a client reached too late to answer', async () => {
    const appt = await asked({ deliver: false });
    const clock = fixedClock(new Date(appt.startAt.getTime() - HOUR));
    await dispatchOutbox({
      clock,
      carrier: { name: 'accepts', send: async (m) => ({ providerRef: `r_${m.id}`, accepted: true }) },
    });
    for (const m of await prisma.outboxMessage.findMany()) {
      await recordReceipt({
        providerRef: m.providerRef!, state: 'delivered',
        occurredAt: new Date(appt.startAt.getTime() - HOUR),
      });
    }

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.unanswerable).toEqual([appt.id]);
    expect(run.exempted).toEqual([appt.id]);
    // Reached, so not the practice's addressing problem — a different exemption.
    expect(run.undelivered).toEqual([]);
    expect(run.noResponse).toEqual([]);
    expect(run.noShow).toEqual([]);

    const after = await row(appt.id);
    expect(after.confirmation).toBe('not_required');
    expect(after.status).toBe('scheduled');
    expect(after.chargeFeeCents).toBeNull();
  });

  /** Its own code, so the three exemptions never blur into one number. */
  it('records why it stood down, in a code of its own', async () => {
    const appt = await asked({ deliver: false });
    const clock = fixedClock(new Date(appt.startAt.getTime() - HOUR));
    await dispatchOutbox({
      clock,
      carrier: { name: 'accepts', send: async (m) => ({ providerRef: `r_${m.id}`, accepted: true }) },
    });
    for (const m of await prisma.outboxMessage.findMany()) {
      await recordReceipt({
        providerRef: m.providerRef!, state: 'delivered',
        occurredAt: new Date(appt.startAt.getTime() - HOUR),
      });
    }
    await runNonResponseSweep(afterGrace(appt));

    const reasons = (await prisma.auditEvent.findMany({
      where: { resourceId: appt.id, actorId: 'system' }, orderBy: { at: 'asc' },
    })).map((r) => r.reason);
    expect(reasons.at(-1)).toBe('confirmation_unanswerable');
    expect(reasons).not.toContain('confirmation_undelivered');
  });

  /**
   * The other half, and the one that keeps this from being an exemption for
   * anybody who wants fewer messages. A day-of client whose single message
   * arrived with the whole lead ahead of it had a real chance to answer, and
   * saying nothing costs them exactly what it costs anybody else.
   */
  it('still charges a light cadence that was reached in time', async () => {
    const client = await makeClient(therapist.id);
    await prisma.client.update({
      where: { id: client.id },
      data: { email: 'tc@example.test', reminderCadence: 'day_of' },
    });
    const appt = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: TUESDAY,
      startMinute: THREE_PM, type: 'standard', modality: 'in_person',
      clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });
    // Queued and delivered the moment it falls due: the full three-hour lead.
    const dueAt = new Date(appt.startAt.getTime() - 3 * HOUR);
    await runReminderHorizon(fixedClock(dueAt));
    await deliverOutbox(dueAt);

    expect((await row(appt.id)).confirmation).toBe('pending');
    expect(await prisma.appointmentReminder.count({ where: { appointmentId: appt.id } })).toBe(1);

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.unanswerable).toEqual([]);
    expect(run.noShow).toEqual([appt.id]);
    expect((await row(appt.id)).chargeFeeCents).toBe(9000);
  });

  /**
   * Zero is off, and off means the fee goes back on messages that arrived with
   * minutes to spare. It is a setting rather than a constant because a practice
   * with a different channel mix may have a different honest answer — not
   * because there is any doubt about which direction is safer.
   */
  it('charges on a late arrival where the practice has set no window', async () => {
    await settings({ answerWindowMinutes: 0 });
    const appt = await asked({ deliver: false });
    const clock = fixedClock(new Date(appt.startAt.getTime() - HOUR));
    await dispatchOutbox({
      clock,
      carrier: { name: 'accepts', send: async (m) => ({ providerRef: `r_${m.id}`, accepted: true }) },
    });
    for (const m of await prisma.outboxMessage.findMany()) {
      await recordReceipt({
        providerRef: m.providerRef!, state: 'delivered',
        occurredAt: new Date(appt.startAt.getTime() - HOUR),
      });
    }

    const run = await runNonResponseSweep(afterGrace(appt));
    expect(run.unanswerable).toEqual([]);
    expect(run.noShow).toEqual([appt.id]);
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
    // The group sits at 11am, four hours before this suite's usual 3pm, so a
    // delivery pinned to START would land an hour before it — inside the
    // answering window, and exempt. Leads are measured from the group's own
    // start for the same reason the fixture above is.
    const groupStart = new Date(START.getTime() - 4 * HOUR);
    for (const lead of [5 * DAY, DAY, 3 * HOUR]) {
      const at = new Date(groupStart.getTime() - lead);
      await runReminderHorizon(fixedClock(at));
      await deliverOutbox(at);
    }

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

/**
 * The second structural lint this feature asks for, and the one with money
 * attached.
 *
 * Everything above tests the sweep that exists. This tests the backfill script
 * somebody writes next quarter to "tidy up old pending rows", which sets
 * `no_response` across a table and hands the fee rule a set of appointments
 * nobody was ever asked about — including the clients on `reminderPreference:
 * 'none'`, for whom the exemption is a safety setting rather than a preference.
 * Every behavioural spec in this file would still pass, because none of them
 * calls it.
 *
 * So the check is on the shape of the module: a file that concludes silence
 * must, in the same file, be seen to have asked whether asking was allowed.
 */
/** Files that conclude a client did not answer. See `assertsLiteral`. */
const concludesNoResponse = (source: string) => assertsLiteral(source, 'confirmation', 'no_response') > 0;

export function unguardedNoResponseWrites(files: { path: string; source: string }[]): string[] {
  return files
    .filter(({ source }) => concludesNoResponse(source))
    .filter(({ source }) => !source.includes('confirmationRequired'))
    .map(({ path }) => path);
}

/**
 * The same lint for the other precondition, added in P2.
 *
 * A file that concludes silence must, in the same file, be seen to have asked
 * whether the message actually arrived. The behavioural specs above cover the
 * one module that does it today; this covers the backfill script, the "fix up
 * the stuck rows" admin action and the second sweep somebody writes next year —
 * none of which exist yet, all of which would be charging on `queued` again.
 *
 * It greps for `deliveryProven` rather than for the string `delivered`, because
 * the point is that the decision goes through the one pure function that owns
 * it: a hand-rolled `deliveryState === 'delivered'` somewhere else is a second
 * copy of the rule, and second copies are how "one delivered stage is enough"
 * quietly becomes something else.
 */
export function deliveryBlindNoResponseWrites(files: { path: string; source: string }[]): string[] {
  return files
    .filter(({ source }) => concludesNoResponse(source))
    .filter(({ source }) => !source.includes('deliveryProven'))
    .map(({ path }) => path);
}

/**
 * The third precondition, added in P2-3.
 *
 * A file that concludes silence must, in the same file, be seen to have asked
 * whether the message arrived *in time to be answered*. Same argument as the
 * delivery lint and the same shape: it greps for `answerable` rather than for a
 * hand-rolled subtraction, because a second copy of "how long is long enough"
 * is how a considered window quietly becomes zero.
 */
export function windowBlindNoResponseWrites(files: { path: string; source: string }[]): string[] {
  return files
    .filter(({ source }) => concludesNoResponse(source))
    .filter(({ source }) => !source.includes('answerable'))
    .map(({ path }) => path);
}

describe('no path to a fee that has not asked whether it may charge', () => {
  const files = () => {
    const out: { path: string; source: string }[] = [];
    for (const dir of ['src', 'app']) {
      for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
        const path = `${dir}/${f}`;
        if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
        if (path.startsWith('src/generated/')) continue;
        if (!statSync(path).isFile()) continue;
        out.push({ path, source: readFileSync(path, 'utf8') });
      }
    }
    return out;
  };

  it('holds across src/ and app/', () => {
    expect(unguardedNoResponseWrites(files())).toEqual([]);
  });

  it('is concluded by exactly one module today', () => {
    const writers = files()
      .filter(({ source }) => concludesNoResponse(source))
      .map(({ path }) => path);
    expect(writers).toEqual(['src/scheduling/nonresponse.ts']);
  });

  it('does not mistake a report that reads the value for one that writes it', () => {
    // The auditor's "show me the charges nobody decided" query names the same
    // value and decides nothing. A lint that cannot tell the two apart would
    // either fail on every report or pass on every backfill.
    const count = (src: string) => assertsLiteral(src, 'confirmation', 'no_response');
    expect(count(`
      prisma.appointment.findMany({ where: { confirmation: 'no_response', status: 'no_show' } })
    `)).toBe(0);
    expect(count(`
      tx.appointment.update({ where: { id }, data: { confirmation: 'no_response' } })
    `)).toBe(1);
    expect(count(`
      setStatus(SYSTEM_ACTOR, id, 'no_show', { clock, confirmation: 'no_response' })
    `)).toBe(1);
  });

  /**
   * P2. Queuing a message proves the practice intended to ask; it does not
   * prove anybody was asked. Without this, the money rule is one refactor away
   * from resting on intent again — and the failure is invisible, because an
   * undelivered message and an ignored one produce identical evidence.
   */
  it('holds for the delivery precondition too', () => {
    expect(deliveryBlindNoResponseWrites(files())).toEqual([]);
  });

  /**
   * P2-3. Delivery proves the client was reached; it says nothing about
   * whether they were reached in time. Without this, the answering window is
   * one refactor away from being dropped — and the failure is invisible in
   * exactly the same way, because a message answered too late to matter and a
   * message ignored produce identical evidence.
   */
  it('holds for the answering window too', () => {
    expect(windowBlindNoResponseWrites(files())).toEqual([]);
  });

  it('catches a sweep that checks delivery but not the time to answer', () => {
    const planted = [{
      path: 'src/scheduling/hasty-sweep.ts',
      source: `
        if (!confirmationRequired(client, appt, settings)) return;
        if (!deliveryProven(states)) return;
        await tx.appointment.update({ where: { id }, data: { confirmation: 'no_response' } });
      `,
    }];
    expect(windowBlindNoResponseWrites(planted)).toEqual(['src/scheduling/hasty-sweep.ts']);
  });

  it('catches a sweep that checks eligibility but not delivery', () => {
    const planted = [{
      path: 'src/scheduling/second-sweep.ts',
      source: `if (!confirmationRequired(client, appt, settings)) continue;
        await tx.appointment.update({ where: { id }, data: { confirmation: 'no_response' } });`,
    }];
    // The old lint is satisfied and the new one is not, which is exactly the
    // regression this phase exists to make impossible.
    expect(unguardedNoResponseWrites(planted)).toEqual([]);
    expect(deliveryBlindNoResponseWrites(planted)).toEqual(['src/scheduling/second-sweep.ts']);
  });

  it('catches the backfill nobody has written yet', () => {
    // The planted violation, so the lint is asserted rather than asserted-about.
    const planted = [{
      path: 'src/scripts/tidy-pending.ts',
      source: `await prisma.appointment.updateMany({
        where: { confirmation: 'pending' },
        data: { confirmation: 'no_response' },
      });`,
    }];
    expect(unguardedNoResponseWrites(planted)).toEqual(['src/scripts/tidy-pending.ts']);
    // And clears once the eligibility question is asked in the same file.
    expect(unguardedNoResponseWrites([{
      ...planted[0]!,
      source: `if (confirmationRequired(client, appt, settings)) {${planted[0]!.source}}`,
    }])).toEqual([]);
  });
});

/**
 * P0-9's quietest requirement. The cadence and the sweep run unattended, so
 * their output goes wherever a server's stdout goes — a log aggregator, a
 * screen in an office, a support ticket. An appointment id in a log line is a
 * client id one join away, and this application's whole claim is that the
 * record is the only place the record lives. Counts only.
 */
it('the unattended jobs log counts, never ids', () => {
  const offenders: string[] = [];
  for (const path of [
    'src/scheduling/reminders.ts', 'src/scheduling/nonresponse.ts',
    'scripts/reminders-run.ts', 'scripts/sweep-run.ts',
  ]) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!/\bconsole\.\w+/.test(line)) continue;
      // The only interpolation allowed in a log line is a count of something.
      for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
        if (!/\.length\s*$/.test(m[1] ?? '')) offenders.push(`${path}: \${${m[1]}}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
