import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, HOUR } from '../clock';
import { prisma } from '../db';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from '../scheduling/booking';
import { PHRASES_BY_LANGUAGE, classifyInbound, openInboundReplies, receiveInbound, recentlyHandledInboundReplies, reopenInboundReply, resolveInboundReply } from './inbound';
import { LANGUAGES } from './outbox';

/** 2026-09-01 15:00 America/New_York, as everywhere else in this suite. */
const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;
const START = new Date('2026-09-01T19:00:00Z');
/** A day before the session: the message arrives while the hour still stands. */
const clock = fixedClock(new Date(START.getTime() - 24 * HOUR));

let desk: Awaited<ReturnType<typeof makeUser>>;
let therapist: Awaited<ReturnType<typeof makeUser>>;

/**
 * A sentence no schema in this application has anywhere to put. Every
 * behavioural test below plants it and then goes looking, because "we do not
 * store the body" is a claim about columns that do not exist, and the way to
 * check a column does not exist is to try to find the value in one.
 */
const DISCLOSURE = 'I have been having a really bad week and I do not know who to call';

async function reachableClient(overrides: Record<string, unknown> = {}) {
  const client = await makeClient(therapist.id);
  return prisma.client.update({
    where: { id: client.id },
    data: { email: 'tc@example.test', phone: '555-0142', ...overrides },
  });
}

const bookFor = (clientId: string, startMinute = THREE_PM) =>
  bookAppointment(actor(desk), {
    clientId, clinicianId: therapist.id, date: TUESDAY, startMinute,
    type: 'standard', modality: 'in_person',
  });

beforeEach(async () => {
  await resetDb();
  await settings({ practicePhone: '(555) 010-0199', messagingName: 'Stillwater' });
  await makeRoom('Room 1');
  desk = await makeUser('front_desk');
  therapist = await makeUser('therapist');
  await prisma.availability.create({
    data: { userId: therapist.id, weekday: 2, startMinute: 540, endMinute: 1020 },
  });
});
afterAll(() => prisma.$disconnect());

describe('classifyInbound — three codes, and everything else is the third', () => {
  it('reads the ordinary yes and the ordinary no', () => {
    for (const yes of ['Y', 'yes', 'YES', 'Yes please', 'yep', 'ok', 'Confirm', "I'll be there"]) {
      expect(classifyInbound(yes), yes).toBe('confirm');
    }
    for (const no of ['N', 'no', 'NOPE', 'cancel', "Can't make it", 'not coming']) {
      expect(classifyInbound(no), no).toBe('decline');
    }
  });

  it('does not care about case, punctuation, spacing or an apostrophe', () => {
    expect(classifyInbound('  YES!!  ')).toBe('confirm');
    expect(classifyInbound('Yes.')).toBe('confirm');
    expect(classifyInbound('cant make it')).toBe('decline');
    expect(classifyInbound('can’t make it')).toBe('decline');
  });

  /**
   * The case the whole strictness exists for. This message starts with a
   * keyword and is not a keyword reply: it is a person telling their practice
   * something. A "starts with no" rule would classify it, cancel a session on
   * it, and drop the rest on the floor with nobody told.
   */
  it('refuses to classify a message that merely begins with a keyword', () => {
    expect(classifyInbound('No I cannot come, my mother died last night')).toBe('unparsed');
    expect(classifyInbound('yes but can we talk about something first')).toBe('unparsed');
  });

  it('treats an empty message, an emoji and a stray number as unparsed', () => {
    expect(classifyInbound('')).toBe('unparsed');
    expect(classifyInbound('   ')).toBe('unparsed');
    expect(classifyInbound('👍')).toBe('unparsed');
    expect(classifyInbound('4')).toBe('unparsed');
  });

  it('reads the Spanish yes and no, accent or no accent', () => {
    for (const yes of ['Sí', 'si', 'SÍ', 'Sí gracias', 'claro', 'Confirmo', 'Allí estaré']) {
      expect(classifyInbound(yes), yes).toBe('confirm');
    }
    for (const no of ['No', 'cancelar', 'No puedo', 'no podré', 'No voy', 'no asistiré']) {
      expect(classifyInbound(no), no).toBe('decline');
    }
  });

  /**
   * The accent is the whole bug. `normalise` collapses everything that is not
   * `a-z`, so an unfolded `sí` arrives as `s` — not a phrase, therefore
   * `unparsed`, therefore an alert to a clinician and a phone call, every
   * single time a Spanish-speaking client says yes.
   */
  it('folds the accent into its letter rather than deleting it', () => {
    expect(classifyInbound('sí')).toBe('confirm');
    expect(classifyInbound('s')).toBe('unparsed');
  });

  it('is still strict in Spanish — a sentence that starts with a keyword is not a reply', () => {
    expect(classifyInbound('No puedo ir, mi madre murió anoche')).toBe('unparsed');
    expect(classifyInbound('sí pero necesito hablar con alguien primero')).toBe('unparsed');
  });

  /**
   * The union is read language-blind, because an inbound message does not
   * arrive with a language on it and the client's stored preference is about
   * what the practice writes, not what they write back. That is only safe
   * while no phrase means opposite things in two languages — a property of
   * the data, asserted here rather than hoped for. When a third language
   * breaks it, the fix is to delete the ambiguous phrase from both and let it
   * fall to `unparsed`, which is a person ringing the client.
   */
  it('has no phrase that means confirm in one language and decline in another', () => {
    const seen = new Map<string, string>();
    for (const language of LANGUAGES) {
      for (const [phrase, classification] of Object.entries(PHRASES_BY_LANGUAGE[language])) {
        const previous = seen.get(phrase);
        expect(previous ?? classification, `${phrase} (${language})`).toBe(classification);
        seen.set(phrase, classification);
      }
    }
  });

  it('stores every phrase in the folded form normalise produces', () => {
    for (const language of LANGUAGES) {
      for (const phrase of Object.keys(PHRASES_BY_LANGUAGE[language])) {
        expect(classifyInbound(phrase), `${language}: ${phrase}`).not.toBe('unparsed');
      }
    }
  });
});

describe('receiveInbound — an answer, and never a cancellation', () => {
  it('records a confirm against the next upcoming session', async () => {
    const client = await reachableClient();
    const appt = await bookFor(client.id);

    const result = await receiveInbound({ from: '555-0142', body: 'YES' }, { clock });
    expect(result).toEqual({ classification: 'confirm', clientId: client.id, appointmentId: appt.id });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).confirmation)
      .toBe('confirmed');
  });

  /**
   * The rule that makes the whole channel safe to have. A caller ID is not a
   * credential: the portal link carries 24 random bytes and shows the fee
   * before it applies, and a phone number is public. So a keyword decline
   * records the answer, frees nothing, charges nothing, and lands on the
   * front-desk list where a person rings them — which is also all a forged
   * `NO` from a spoofed number can ever achieve.
   */
  it('records a decline without cancelling the session or touching money', async () => {
    const client = await reachableClient();
    const appt = await bookFor(client.id);

    await receiveInbound({ from: '555-0142', body: 'NO' }, { clock });

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.confirmation).toBe('declined');
    expect(after.status).toBe('scheduled');
    expect(after.chargeFeeCents).toBeNull();
    expect(after.cancelledAt).toBeNull();
  });

  it('takes an answer even from a client with nothing booked, and records only that', async () => {
    const client = await reachableClient();
    const result = await receiveInbound({ from: '555-0142', body: 'yes' }, { clock });
    expect(result.appointmentId).toBeNull();
    expect(await prisma.inboundReply.count({ where: { clientId: client.id } })).toBe(1);
  });

  it('writes nothing at all for a number no client answers to', async () => {
    await reachableClient();
    const result = await receiveInbound({ from: '555-9999', body: 'yes' }, { clock });
    expect(result.ignored).toBe('unknown_sender');
    expect(await prisma.inboundReply.count()).toBe(0);
    expect(await prisma.alert.count()).toBe(0);
  });

  /**
   * A couple, a parent and a teenager, a carer: one phone, two records. This is
   * the case that must not guess. Confirming the wrong person's hour is the
   * mild version — an `unparsed` from a shared phone would raise an alert about
   * the wrong client to the wrong clinician, which is a disclosure.
   */
  it('refuses to guess when two clients share a number', async () => {
    await reachableClient();
    const second = await makeClient(therapist.id);
    // The same line, written the way the other record happens to hold it.
    await prisma.client.update({ where: { id: second.id }, data: { phone: '(555) 0142' } });

    const result = await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });
    expect(result.ignored).toBe('ambiguous_sender');
    expect(result.clientId).toBeNull();
    expect(await prisma.inboundReply.count()).toBe(0);
    expect(await prisma.alert.count()).toBe(0);
    expect(await prisma.outboxMessage.count()).toBe(0);
  });
});

describe('an unparsed reply — one alert, one auto-reply, and nothing to read', () => {
  it('raises an alert to the treating clinician alone, carrying a code', async () => {
    const client = await reachableClient();
    const other = await makeUser('therapist');
    await bookFor(client.id);

    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });

    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.recipientId).toBe(therapist.id);
    expect(alerts[0]!.recipientId).not.toBe(other.id);
    expect(alerts[0]!.kind).toBe('inbound_unparsed');
    expect(alerts[0]!.reasons).toEqual(['inbound:unparsed']);
  });

  /**
   * The one client-facing body allowed to carry an outside service's number.
   * 988 appears as digits and not by name because the line is called the
   * Suicide & Crisis Lifeline and both of those words are on the deny-list —
   * which is why `assertDiscreet` passing this message is itself the assertion.
   */
  it('replies with the practice number and a route to urgent help', async () => {
    const client = await reachableClient();
    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });

    const sent = await prisma.outboxMessage.findMany({ where: { clientId: client.id } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.templateKey).toBe('inbound_unparsed_reply');
    expect(sent[0]!.body).toContain('(555) 010-0199');
    expect(sent[0]!.body).toContain('988');
    expect(sent[0]!.body).toContain('911');
  });

  /**
   * The reply a Spanish-speaking client gets when they write the most acute
   * sentence of their life to a number nobody reads. Same digits, same
   * refusal to name the line, and in the language they wrote the practice in
   * — an English auto-reply here is the moment the routing stops mattering.
   */
  it('replies in the client language, with the same digits and the same silence about why', async () => {
    const client = await reachableClient({ language: 'es' });
    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });

    const sent = await prisma.outboxMessage.findMany({ where: { clientId: client.id } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Recibimos su mensaje');
    expect(sent[0]!.body).toContain('(555) 010-0199');
    expect(sent[0]!.body).toContain('988');
    expect(sent[0]!.body).toContain('911');
  });

  /**
   * `none` is a safety setting, and it means none — a reply to a phone somebody
   * else picks up is the danger it exists for. The alert and the front-desk
   * call still happen; only the outbound message does not.
   */
  it('sends no auto-reply to a client on reminderPreference "none", and still tells somebody', async () => {
    await reachableClient({ reminderPreference: 'none' });
    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });

    expect(await prisma.outboxMessage.count()).toBe(0);
    expect(await prisma.alert.count()).toBe(1);
    expect(await openInboundReplies(actor(desk))).toHaveLength(1);
  });

  it('shows front desk that they wrote, and nothing they wrote', async () => {
    const client = await reachableClient();
    await bookFor(client.id);
    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });

    const list = await openInboundReplies(actor(desk));
    expect(list).toHaveLength(1);
    expect(list[0]!.client.phone).toBe('555-0142');
    expect(JSON.stringify(list[0])).not.toContain('bad week');
  });

  it('drops off the list once somebody has made the call', async () => {
    await reachableClient();
    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });

    const [row] = await openInboundReplies(actor(desk));
    await resolveInboundReply(actor(desk), row!.id, { clock });
    expect(await openInboundReplies(actor(desk))).toEqual([]);
    expect((await prisma.inboundReply.findUniqueOrThrow({ where: { id: row!.id } })).handledById)
      .toBe(desk.id);
  });

  it('puts a mis-clicked "Called them" back on the list, audited (PRD 5)', async () => {
    await reachableClient();
    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });
    const [row] = await openInboundReplies(actor(desk));
    await resolveInboundReply(actor(desk), row!.id, { clock });

    const [handled] = await recentlyHandledInboundReplies(actor(desk), { clock });
    expect(handled).toMatchObject({ id: row!.id, handledBy: { name: desk.name } });
    await reopenInboundReply(actor(desk), row!.id);
    expect((await openInboundReplies(actor(desk))).map((r) => r.id)).toEqual([row!.id]);
    expect(await recentlyHandledInboundReplies(actor(desk), { clock })).toEqual([]);
    expect(await prisma.auditEvent.count({ where: { reason: 'reply:reopened', actorId: desk.id } })).toBe(1);
  });
});

/**
 * D-04, checked by looking rather than by trusting.
 *
 * Every test above is about what the feature does. This one is about the thing
 * that would make all of them worthless: the words surviving somewhere. A
 * client can reply to this number with the most acute sentence this practice
 * ever receives, so the body is planted and then hunted for in every column it
 * could plausibly have reached — the outbox it triggered, the audit row that
 * recorded it, the alert that routed it, the appointment it was about.
 */
describe('the body is never stored, anywhere', () => {
  const contains = (v: unknown) => JSON.stringify(v ?? null).includes('bad week');

  it('leaves no trace of the message in any row it caused', async () => {
    const client = await reachableClient();
    const appt = await bookFor(client.id);
    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });

    expect(contains(await prisma.inboundReply.findMany())).toBe(false);
    expect(contains(await prisma.outboxMessage.findMany())).toBe(false);
    expect(contains(await prisma.alert.findMany())).toBe(false);
    expect(contains(await prisma.auditEvent.findMany())).toBe(false);
    expect(contains(await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } }))).toBe(false);
  });

  it('records the classification as a code in the audit trail, and only that', async () => {
    await reachableClient();
    await receiveInbound({ from: '555-0142', body: DISCLOSURE }, { clock });

    const rows = await prisma.auditEvent.findMany({ where: { reason: { not: null } } });
    expect(rows.map((r) => r.reason)).toEqual(['inbound:unparsed']);
  });
});

/**
 * The structural half, in the shape this codebase already uses twice.
 *
 * The behavioural tests above prove the current code stores nothing. This one
 * is about the migration somebody writes next month that adds a `body` column
 * "just for debugging" — every test above would still pass, because none of
 * them would write to it. So the check is on the model: `InboundReply` may hold
 * identifiers, a classification and timestamps, and there is nowhere in it for
 * a sentence to go.
 */
it('gives the InboundReply model nowhere to put a sentence', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const block = schema.match(/model InboundReply \{([\s\S]*?)\n\}/)?.[1];
  expect(block, 'model InboundReply not found in the schema').toBeTruthy();

  const textFields = [...block!.matchAll(/^\s{2}(\w+)\s+String/gm)].map((m) => m[1]!);
  expect(textFields.sort()).toEqual(['appointmentId', 'clientId', 'handledById', 'id']);
});
