import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, fixedClock } from '../clock';
import { prisma } from '../db';
import { NotFound } from '../errors';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from '../scheduling/booking';
import { runReminderHorizon } from '../scheduling/reminders';
import { classifyReply, handleInboundReply } from './inbound';
import { indiscreetTerms } from './outbox';

/** 2026-09-01 15:00 America/New_York, as everywhere else in this suite. */
const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;
const START = new Date('2026-09-01T19:00:00Z');

/**
 * P1-3. The classifier is pure and it is the whole of what this system
 * understands about an inbound message — which is the point. Everything it
 * cannot map to one of these lands as `unparsed`, and `unparsed` means a person
 * telephones the client, not that anybody reads what they wrote.
 */
describe('classifyReply (pure)', () => {
  it.each([
    'YES', 'yes', 'Yes please', 'y', 'Y', 'confirm', 'CONFIRMED', 'ok', 'okay',
    'yep', 'yeah', 'sure', '1', ' yes ',
  ])('reads %j as a confirmation', (body) => {
    expect(classifyReply(body)).toBe('confirm');
  });

  it.each([
    'NO', 'no', 'n', 'N', 'cancel', 'CANCEL', 'decline', 'nope', '2', ' no ',
  ])('reads %j as a decline', (body) => {
    expect(classifyReply(body)).toBe('decline');
  });

  /**
   * `STOP` is a carrier opt-out keyword, not an answer about Tuesday. Reading
   * it as a decline would cancel a session the client never asked to cancel,
   * and replying to it at all is the one thing a carrier forbids. It is its own
   * classification for both reasons.
   */
  it.each(['STOP', 'stop', 'Stop', 'UNSUBSCRIBE', 'unsubscribe', 'STOPALL', 'quit', 'end'])(
    'reads %j as an opt-out, never as a decline',
    (body) => {
      expect(classifyReply(body)).toBe('opt_out');
    },
  );

  it.each([
    'I am not sure yet',
    'can we talk',
    'Yes but can I come later?',
    "I've been having a really hard week and I don't know if I can face it",
    '',
    '   ',
    '👍',
  ])('gives up on %j rather than guessing', (body) => {
    expect(classifyReply(body)).toBe('unparsed');
  });

  it('refuses a keyword buried in a sentence', () => {
    // "Yes but" is not a yes, and a system that decides it is will cancel or
    // confirm sessions on the strength of a word order. A whole-message match
    // is the only honest one when the cost of being wrong is somebody's hour.
    expect(classifyReply('no idea, sorry')).toBe('unparsed');
    expect(classifyReply('yes if my ride works out')).toBe('unparsed');
  });

  it('ignores trailing punctuation, which people type', () => {
    expect(classifyReply('Yes!')).toBe('confirm');
    expect(classifyReply('no.')).toBe('decline');
  });
});

describe('against the database', () => {
  let desk: Awaited<ReturnType<typeof makeUser>>;
  let therapist: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await settings({ contactPhone: '555-0199' });
    await makeRoom('Room 1');
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
    await prisma.availability.create({
      data: { userId: therapist.id, weekday: 2, startMinute: 540, endMinute: 1020 },
    });
  });
  afterAll(() => prisma.$disconnect());

  /** A client who has been asked, by the real cadence, and has not answered. */
  async function asked(over: { reminderPreference?: 'sms' | 'email' } = {}) {
    const client = await makeClient(therapist.id);
    await prisma.client.update({
      where: { id: client.id },
      data: { phone: '555-0100', email: 'tc@example.test', reminderPreference: over.reminderPreference ?? 'sms' },
    });
    const appt = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: TUESDAY,
      startMinute: THREE_PM, type: 'standard', modality: 'in_person',
      clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 2 * DAY)));
    return { client, appt };
  }

  const clock = () => fixedClock(new Date(START.getTime() - DAY));
  const row = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });

  it('confirms the session the client was actually asked about', async () => {
    const { client, appt } = await asked();

    const out = await handleInboundReply({ from: '555-0100', body: 'YES' }, { clock: clock() });
    expect(out).toMatchObject({ classification: 'confirm', appointmentId: appt.id });
    expect((await row(appt.id)).confirmation).toBe('confirmed');

    const stored = await prisma.inboundReply.findFirstOrThrow({ where: { clientId: client.id } });
    expect(stored.classification).toBe('confirm');
    expect(stored.handledAt).not.toBeNull(); // understood, so nobody needs to ring
  });

  it('declines through the same door a tap uses, so the fee rule is unchanged', async () => {
    const { appt } = await asked();

    await handleInboundReply({ from: '555-0100', body: 'no' }, { clock: clock() });
    const after = await row(appt.id);
    // A day out is outside the 24-hour window by an hour, so no fee — decided
    // by `classifyCancellation` from the clock, exactly as at the front desk.
    expect(after.status).toBe('cancelled');
    expect(after.confirmation).toBe('declined');
    expect(after.chargeFeeCents).toBeNull();
  });

  it('charges a late decline identically, whoever the message came from', async () => {
    const { appt } = await asked();
    await handleInboundReply(
      { from: '555-0100', body: 'CANCEL' },
      { clock: fixedClock(new Date(START.getTime() - 2 * HOUR)) },
    );
    const after = await row(appt.id);
    expect(after.status).toBe('late_cancelled');
    expect(after.chargeFeeCents).toBe(9000);
  });

  /**
   * D-04, and the reason this feature is shaped the way it is. A client can
   * reply with anything, including a crisis disclosure, to a number front desk
   * monitors. So the words are classified and dropped on the floor.
   */
  describe('a reply nobody here can read', () => {
    it('stores the classification and nothing else', async () => {
      const { client } = await asked();
      const secret = 'I have been thinking about hurting myself and I need to talk to someone';

      await handleInboundReply({ from: '555-0100', body: secret }, { clock: clock() });

      const stored = await prisma.inboundReply.findFirstOrThrow({ where: { clientId: client.id } });
      expect(stored.classification).toBe('unparsed');
      expect(JSON.stringify(stored)).not.toContain('hurting');
      // Nowhere else either: not the outbox, not the alert, not the audit log.
      const everywhere = JSON.stringify([
        await prisma.outboxMessage.findMany(),
        await prisma.alert.findMany(),
        await prisma.auditEvent.findMany(),
      ]);
      expect(everywhere).not.toContain('hurting');
      expect(everywhere).not.toContain('thinking about');
    });

    it('raises an alert to the treating clinician, and to nobody else', async () => {
      const { client } = await asked();
      await handleInboundReply({ from: '555-0100', body: 'can we talk' }, { clock: clock() });

      const alerts = await prisma.alert.findMany();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        recipientId: therapist.id, clientId: client.id, kind: 'inbound_unparsed',
      });
      expect(alerts[0]!.reasons).toEqual(['inbound:unparsed']);
    });

    it('answers with a number a person picks up, and stays discreet doing it', async () => {
      await asked();
      await handleInboundReply({ from: '555-0100', body: 'help' }, { clock: clock() });

      const reply = await prisma.outboxMessage.findFirstOrThrow({
        where: { templateKey: 'inbound_unparsed' },
      });
      expect(reply.body).toBe(
        'We cannot read replies to this number. Please call us on 555-0199. '
        + 'If you need urgent help right now, call or text 988 at any hour.',
      );
      // The deny-list still applies. "Crisis line" is itself on it, so the one
      // message that has to carry one says what it is for instead of naming it.
      expect(indiscreetTerms(reply.body)).toEqual([]);
    });

    it('leaves the appointment exactly as it was', async () => {
      const { appt } = await asked();
      await handleInboundReply({ from: '555-0100', body: 'maybe?' }, { clock: clock() });

      const after = await row(appt.id);
      expect(after.status).toBe('scheduled');
      expect(after.confirmation).toBe('pending');
    });

    it('waits for a person, so front desk has something to work', async () => {
      await asked();
      await handleInboundReply({ from: '555-0100', body: 'maybe?' }, { clock: clock() });

      const open = await prisma.inboundReply.findMany({ where: { handledAt: null } });
      expect(open).toHaveLength(1);
    });
  });

  /**
   * The keyword that is not an answer. Treating it as a decline would cancel a
   * session the client never mentioned, and answering it at all is the one
   * thing a carrier forbids.
   */
  describe('an opt-out', () => {
    it('stops the messages instead of cancelling the session', async () => {
      const { client, appt } = await asked();
      await handleInboundReply({ from: '555-0100', body: 'STOP' }, { clock: clock() });

      expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).reminderPreference)
        .toBe('none');
      const after = await row(appt.id);
      expect(after.status).toBe('scheduled');
    });

    it('sends nothing back', async () => {
      await asked();
      const before = await prisma.outboxMessage.count();
      await handleInboundReply({ from: '555-0100', body: 'STOP' }, { clock: clock() });
      expect(await prisma.outboxMessage.count()).toBe(before);
    });

    it('takes the client out of reach of the fee on the next run', async () => {
      const { appt } = await asked();
      await handleInboundReply({ from: '555-0100', body: 'STOP' }, { clock: clock() });

      await runReminderHorizon(clock());
      expect((await row(appt.id)).confirmation).toBe('not_required');
    });
  });

  describe('whose message it is', () => {
    it('refuses a number nobody in the practice has', async () => {
      await asked();
      await expect(handleInboundReply({ from: '555-9999', body: 'yes' }, { clock: clock() }))
        .rejects.toBeInstanceOf(NotFound);
      expect(await prisma.inboundReply.count()).toBe(0);
    });

    it('records a reply with no open question, and changes nothing', async () => {
      const client = await makeClient(therapist.id);
      await prisma.client.update({ where: { id: client.id }, data: { phone: '555-0177' } });

      const out = await handleInboundReply({ from: '555-0177', body: 'yes' }, { clock: clock() });
      expect(out.appointmentId).toBeNull();
      // Nothing to confirm is not an error and not a guess: the reply is on the
      // record, and the practice can see it was answered into silence.
      expect(out.classification).toBe('confirm');
    });

    it('answers the soonest open question, not an arbitrary one', async () => {
      const { client, appt } = await asked();
      const later = await bookAppointment(actor(desk), {
        // The next day, so the cadence has actually asked about it too — a
        // question nobody has put yet is not one this reply could be answering.
        clientId: client.id, clinicianId: therapist.id, date: '2026-09-02',
        startMinute: THREE_PM, type: 'standard', modality: 'in_person',
        clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
      });
      await runReminderHorizon(fixedClock(new Date(START.getTime() - 2 * DAY)));

      await handleInboundReply({ from: '555-0100', body: 'yes' }, { clock: clock() });
      expect((await row(appt.id)).confirmation).toBe('confirmed');
      expect((await row(later.id)).confirmation).toBe('pending');
    });
  });
});

/**
 * The structural half of D-04.
 *
 * `InboundReply` has no column to put a body in, which is the real guarantee.
 * This is the guard for the migration that adds one and the write that fills
 * it — a change every behavioural test above would pass, because none of them
 * would call it.
 */
it('no write to an inbound reply carries what the client said', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(/\binboundReply\.\w+/g)) {
        const args = callArgs(src, (m.index ?? 0) + m[0].length);
        if (/\b(body|text|message|content)\b\s*:/.test(args)) offenders.push(`${path}: ${m[0]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

/** The argument text of the call starting at `from`, parens balanced. */
function callArgs(src: string, from: number): string {
  const open = src.indexOf('(', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}
