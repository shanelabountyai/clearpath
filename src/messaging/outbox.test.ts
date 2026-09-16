import { readFileSync, readdirSync, statSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { makeClient, makeUser, resetDb, settings } from '../test/harness';
import { CLIENT_TEMPLATES, DENY_LISTS, IndiscreetMessage, LANGUAGES, assertDiscreet, clientUrl, fold, indiscreetTerms, queueToClient, queueToClinician } from './outbox';

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
  it('gives every language both halves, and every body', () => {
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

describe('the base URL a client-facing link points at', () => {
  const env = (e: Record<string, string | undefined>) => e as NodeJS.ProcessEnv;

  it('uses the explicit variable, trimmed of its trailing slash', () => {
    expect(clientUrl('/p/abc', env({ CLEARPATH_BASE_URL: 'https://clinic.example.org/' })))
      .toBe('https://clinic.example.org/p/abc');
  });

  it('adds the scheme a pasted host is missing, because a host alone is not a link', () => {
    expect(clientUrl('/f/abc', env({ CLEARPATH_BASE_URL: 'clinic.example.org' })))
      .toBe('https://clinic.example.org/f/abc');
  });

  it("falls back to the deployment's own production host", () => {
    expect(clientUrl('/p/abc', env({ VERCEL_PROJECT_PRODUCTION_URL: 'clearpath.vercel.app' })))
      .toBe('https://clearpath.vercel.app/p/abc');
  });

  it('prefers the explicit variable over it, which is what a custom domain needs', () => {
    expect(clientUrl('/p/abc', env({
      CLEARPATH_BASE_URL: 'https://clinic.example.org',
      VERCEL_PROJECT_PRODUCTION_URL: 'clearpath.vercel.app',
    }))).toBe('https://clinic.example.org/p/abc');
  });

  it('is the dev default when nothing is set outside production', () => {
    expect(clientUrl('/p/abc', env({ NODE_ENV: 'development' }))).toBe('http://localhost:3700/p/abc');
  });

  /**
   * The whole point of the item. A queued link is unrecallable and reports
   * success, so the run has to stop instead.
   */
  it('refuses to build a link in production with no host configured', () => {
    expect(() => clientUrl('/p/abc', env({ NODE_ENV: 'production' }))).toThrow(/CLEARPATH_BASE_URL/);
  });

  /**
   * `db:seed:prod` is a local `tsx` run against Neon: no NODE_ENV, every link
   * it writes client-facing, and 25 minutes of it before anyone looks.
   */
  it('refuses for a command pointed at the deployed database, NODE_ENV or not', () => {
    expect(() => clientUrl('/p/abc', env({ CLEARPATH_ALLOW_CLOUD_DB: '1' }))).toThrow(/CLEARPATH_BASE_URL/);
  });

  it('names no token in the refusal', () => {
    try {
      clientUrl('/p/secret-token-abc', env({ NODE_ENV: 'production' }));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-token-abc');
    }
  });

  it('is the only place that knows a client-facing host', () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'app', 'prisma']) {
      for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
        const path = `${dir}/${f}`;
        if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
        if (path === 'src/messaging/outbox.ts' || path.startsWith('src/generated/')) continue;
        if (!statSync(path).isFile()) continue;
        // A client-facing link is an absolute URL somewhere near a portal or
        // form path. Anything building one outside `clientUrl` is a host that
        // can be wrong in production with nothing to report it.
        if (/https?:\/\/[^'"`\s]*(localhost:3700|\/[pf]\/)/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
