import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { makeClient, makeUser, resetDb, settings } from '../test/harness';
import { CLIENT_TEMPLATES, DENY_LISTS, IndiscreetMessage, LANGUAGES, assertDiscreet, fold, indiscreetTerms, queueToClient, queueToClinician } from './outbox';

beforeEach(async () => {
  await resetDb();
  await settings({ messagingName: 'Stillwater', name: 'Stillwater Counseling' });
});
afterAll(() => prisma.$disconnect());

describe('the discretion lint', () => {
  it('passes a reminder that says when and where and nothing else', () => {
    const { body } = CLIENT_TEMPLATES.en.appointment_reminder({
      practice: 'Stillwater',
      phone: '(555) 010-0199',
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
    for (const language of LANGUAGES) {
      for (const [key, build] of Object.entries(CLIENT_TEMPLATES[language])) {
        const { subject, body } = build({
          practice: 'Stillwater', phone: '(555) 010-0199',
          startAt: new Date('2026-09-01T19:00:00Z'), link: 'https://example.test/f/abc',
        });
        expect(indiscreetTerms(body), `${language}.${key}`).toEqual([]);
        expect(indiscreetTerms(subject ?? ''), `${language}.${key}`).toEqual([]);
      }
    }
  });

  it('is blunt on purpose — every entry is a substring match', () => {
    expect(DENY_LISTS.en.length).toBeGreaterThan(20);
    expect(indiscreetTerms('supervisory review')).toEqual(['supervis']);
  });
});

describe('a language is templates and a deny-list, or it is not a language', () => {
  it('gives every language both halves, and all six bodies', () => {
    for (const language of LANGUAGES) {
      expect(DENY_LISTS[language].length, language).toBeGreaterThan(20);
      expect(Object.keys(CLIENT_TEMPLATES[language]).sort(), language)
        .toEqual(Object.keys(CLIENT_TEMPLATES.en).sort());
    }
  });

  /**
   * A term with an accent on it is a term that matches nothing, because the
   * haystack is folded before the comparison and the needle is not. Silent,
   * and it disables exactly the entries a Spanish list exists for.
   */
  it('stores every term in the folded form it is compared in', () => {
    for (const language of LANGUAGES) {
      for (const term of DENY_LISTS[language]) expect(fold(term), language).toBe(term);
    }
  });

  it('catches the accented spelling, which is the one anyone writes', () => {
    expect(indiscreetTerms('Su cita de terapia')).toEqual(['terapia']);
    expect(indiscreetTerms('DEPRESIÓN')).toEqual(['depresion']);
    expect(indiscreetTerms('evaluación psicológica')).toEqual(['psicolog', 'evaluacion']);
  });

  /**
   * The regression this whole item exists for: before the Spanish list, a
   * Spanish body carrying the most disclosing word available sailed through
   * the gate and was sent.
   */
  it('refuses a Spanish body that says why, the way it refuses an English one', () => {
    expect(() => assertDiscreet('Recordatorio: su terapia es el martes')).toThrow(IndiscreetMessage);
    expect(() => assertDiscreet('Resultados de su evaluación de ansiedad')).toThrow(IndiscreetMessage);
    expect(() => assertDiscreet('Stillwater Consejería — martes 15:00')).toThrow(IndiscreetMessage);
  });

  it('checks one body against every language, never just the client\'s own', () => {
    // An English template with one Spanish word left in it is still caught,
    // and so is the reverse. Nothing here passes the reader's language in.
    expect(indiscreetTerms('Your appointment for terapia is Tuesday')).toEqual(['terapia']);
    expect(indiscreetTerms('Su cita de counseling es el martes')).toEqual(['counseling']);
  });

  it('renders the Spanish reminder in Spanish, weekday included', () => {
    const { body } = CLIENT_TEMPLATES.es.appointment_reminder({
      practice: 'Stillwater',
      phone: '(555) 010-0199',
      startAt: new Date('2026-09-01T19:00:00Z'),
      link: 'http://localhost:3700/p/abc123',
    });
    expect(body).toContain('martes 15:00');
    expect(body).toContain('http://localhost:3700/p/abc123');
    expect(indiscreetTerms(body)).toEqual([]);
  });

  /**
   * The English body names 988 rather than the Suicide & Crisis Lifeline
   * because both words are deny-listed. The Spanish one is under the identical
   * constraint — `crisis` is spelled the same in both lists — and takes the
   * identical way out.
   */
  it('points a Spanish speaker at the digits, never at the name of the line', () => {
    const { body } = CLIENT_TEMPLATES.es.inbound_unparsed_reply({
      practice: 'Stillwater', phone: '(555) 010-0199',
    });
    expect(body).toContain('988');
    expect(body).toContain('911');
    expect(body).toContain('(555) 010-0199');
    expect(indiscreetTerms(body)).toEqual([]);
  });
});

describe('queueing to a client', () => {
  it('writes the client in their own language, deny-list and all', async () => {
    const t = await makeUser('therapist');
    const c = await makeClient(t.id);
    await prisma.client.update({ where: { id: c.id }, data: { language: 'es' } });
    const msg = await queueToClient({
      clientId: c.id, templateKey: 'appointment_reminder',
      scheduledFor: new Date('2026-08-31T19:00:00Z'), startAt: new Date('2026-09-01T19:00:00Z'),
      link: 'http://localhost:3700/p/abc123',
    });
    expect(msg?.subject).toBe('Recordatorio de cita');
    expect(msg?.body).toContain('martes 15:00');
    expect(indiscreetTerms(msg!.body)).toEqual([]);
  });

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
