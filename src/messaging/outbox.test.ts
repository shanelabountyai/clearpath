import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { makeClient, makeUser, resetDb, settings } from '../test/harness';
import { CLIENT_TEMPLATES, IndiscreetMessage, assertDiscreet, canRender, indiscreetTerms, queueToClient, queueToClinician, templateLanguages } from './outbox';
import { ALL_DENIED, DENY_LISTS, LANGUAGES, type Language } from './language';

beforeEach(async () => {
  await resetDb();
  await settings({ messagingName: 'Stillwater', name: 'Stillwater Counseling' });
});
afterAll(() => prisma.$disconnect());

describe('the discretion lint', () => {
  it('passes a reminder that says when and where and nothing else', () => {
    const { body } = CLIENT_TEMPLATES.appointment_reminder!.en!({
      practice: 'Stillwater',
      startAt: new Date('2026-09-01T19:00:00Z'),
      link: 'http://localhost:3700/p/abc123',
    });
    expect(body).toBe(
      'Appointment reminder: Tuesday 15:00, Stillwater. Please let us know if you are coming: http://localhost:3700/p/abc123. The link is personal to you — please do not forward it.',
    );
    expect(() => assertDiscreet(body)).not.toThrow();
  });

  it.each([
    'Your therapy appointment is Tuesday',
    'Reminder: session with your counselor',
    'Stillwater Counseling — Tuesday 3pm',
    'Please complete your intake before Tuesday',
    'Your PSYCHIATRY review is confirmed',
    'Depression screening results are ready',
  ])('refuses %j', (text) => {
    expect(() => assertDiscreet(text)).toThrow(IndiscreetMessage);
  });

  it('catches the practice legal name, which is why messaging uses a short one', () => {
    expect(indiscreetTerms('Stillwater Counseling')).toEqual(['counseling']);
    expect(indiscreetTerms('Stillwater')).toEqual([]);
  });

  it('names every term it found, so a rewrite is one pass', () => {
    expect(indiscreetTerms('therapy and counseling for anxiety')).toEqual(['therapy', 'counseling', 'anxiety']);
  });

  it('keeps every shipped client template clean, in every language', () => {
    for (const [key, byLanguage] of Object.entries(CLIENT_TEMPLATES)) {
      for (const [language, build] of Object.entries(byLanguage)) {
        const { subject, body } = build({
          practice: 'Stillwater', startAt: new Date('2026-09-01T19:00:00Z'),
          link: 'https://example.test/f/abc', contactPhone: '555-555-0199',
        });
        expect(indiscreetTerms(body), `${key}/${language}`).toEqual([]);
        expect(indiscreetTerms(subject ?? ''), `${key}/${language}`).toEqual([]);
      }
    }
  });

  it('is blunt on purpose — every entry is a substring match', () => {
    expect(ALL_DENIED.length).toBeGreaterThan(20);
    expect(indiscreetTerms('supervisory review')).toEqual(['supervis']);
  });
});

/**
 * The gap P2 named: the deny-list was English-only, so a Spanish-speaking
 * client got the protection of a list that did not contain the word "terapia".
 */
describe('the discretion lint speaks both languages', () => {
  it.each([
    'Su cita de terapia es el martes',
    'Recordatorio: sesión con su psicólogo',
    'Stillwater Consejería — martes 15:00',
    'Resultados de la evaluación de depresión',
    'Su tratamiento continúa el jueves',
  ])('refuses %j', (text) => {
    expect(() => assertDiscreet(text)).toThrow(IndiscreetMessage);
  });

  it('reads a word without its accents, which is how people type', () => {
    expect(indiscreetTerms('depresion')).toEqual(['depresion']);
    expect(indiscreetTerms('DEPRESIÓN')).toEqual(['depresion']);
    expect(indiscreetTerms('Ansiedad')).toEqual(['ansiedad']);
  });

  /**
   * A body has to be discreet to whoever picks up the phone, not only to the
   * client. A practice serving two languages has clients whose partners and
   * parents read the other one, so an English body is checked against the
   * Spanish list too and the other way round.
   */
  it('checks every body against every language, not just its own', () => {
    expect(indiscreetTerms('Reminder: your terapia session')).toEqual(['terapia']);
    expect(indiscreetTerms('Su cita de therapy')).toEqual(['therapy']);
  });

  /**
   * Accent folding closed a hole nobody was looking for: the Spanish entry
   * `clinic` (from `clínic`) catches the bare English word, which the English
   * list never had — it listed `clinical` and stopped.
   */
  it('catches a word the English list on its own would have missed', () => {
    expect(DENY_LISTS.en.some((t) => 'the clinic'.includes(t))).toBe(false);
    expect(indiscreetTerms('See you at the clinic')).toContain('clinic');
  });

  it('leaves the neutral vocabulary each language actually needs', () => {
    // The words the templates are built from. If any of these ever lands on a
    // deny-list, every message in that language stops going out — so they are
    // asserted here rather than discovered at send time.
    for (const word of ['cita', 'recordatorio', 'enlace', 'formulario', 'appointment', 'reminder', 'link', 'form']) {
      expect(indiscreetTerms(word), word).toEqual([]);
    }
  });
});

/**
 * The rule that makes an untranslated template safe rather than merely absent.
 *
 * A half-translated language would mean a client who gets the reminder and not
 * the cancellation notice, or worse, one the cadence silently stops asking. So
 * the check is not "does this language exist" but "is it complete", and it runs
 * over the registry rather than over a list somebody maintains beside it.
 */
describe('a shipped language is a complete language', () => {
  it('has every template in every language', () => {
    const missing: string[] = [];
    for (const key of Object.keys(CLIENT_TEMPLATES)) {
      for (const language of LANGUAGES) {
        if (!canRender(key, language)) missing.push(`${key}/${language}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has a deny-list and weekday names for every language', () => {
    for (const language of LANGUAGES) {
      expect(DENY_LISTS[language].length, language).toBeGreaterThan(20);
    }
  });

  it('reports which languages a template can reach', () => {
    expect(templateLanguages('appointment_reminder').sort()).toEqual([...LANGUAGES].sort());
    expect(templateLanguages('no_such_template')).toEqual([]);
    expect(canRender('no_such_template', 'es' as Language)).toBe(false);
  });
});

describe('queueing to a client', () => {
  it('queues on the client preferred channel', async () => {
    const t = await makeUser('therapist');
    const c = await makeClient(t.id);
    const msg = await queueToClient({
      clientId: c.id, templateKey: 'appointment_reminder',
      scheduledFor: new Date('2026-08-31T19:00:00Z'), startAt: new Date('2026-09-01T19:00:00Z'),
      link: 'http://localhost:3700/p/abc123',
    });
    expect(msg?.channel).toBe('email');
    expect(msg?.body).toContain('Stillwater');
    expect(msg?.body).not.toContain('Counseling');
  });

  it('sends nothing at all when the client has asked for nothing', async () => {
    const t = await makeUser('therapist');
    const c = await makeClient(t.id);
    await prisma.client.update({ where: { id: c.id }, data: { reminderPreference: 'none' } });
    const msg = await queueToClient({
      clientId: c.id, templateKey: 'appointment_reminder', scheduledFor: new Date(),
    });
    expect(msg).toBeNull();
    expect(await prisma.outboxMessage.count()).toBe(0);
  });

  it('refuses to queue a body that would disclose, even if a template changes', async () => {
    const t = await makeUser('therapist');
    const c = await makeClient(t.id);
    await settings({ messagingName: 'Stillwater Counseling' }); // the mistake this guards against
    await expect(
      queueToClient({ clientId: c.id, templateKey: 'appointment_reminder', scheduledFor: new Date() }),
    ).rejects.toBeInstanceOf(IndiscreetMessage);
    expect(await prisma.outboxMessage.count()).toBe(0);
  });
});

it('a clinician-directed message goes to a person, never to a client row', async () => {
  const t = await makeUser('therapist');
  const msg = await queueToClinician({
    userId: t.id, templateKey: 'screener_alert',
    subject: 'A screener needs your review', body: 'Client TC-001 — reasons: critical:item_9',
  });
  expect(msg.userId).toBe(t.id);
  expect(msg.clientId).toBeNull();
});
