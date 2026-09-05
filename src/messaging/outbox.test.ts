import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { makeClient, makeUser, resetDb, settings } from '../test/harness';
import { CLIENT_TEMPLATES, DENY_LIST, IndiscreetMessage, assertDiscreet, indiscreetTerms, queueToClient, queueToClinician } from './outbox';

beforeEach(async () => {
  await resetDb();
  await settings({ messagingName: 'Stillwater', name: 'Stillwater Counseling' });
});
afterAll(() => prisma.$disconnect());

describe('the discretion lint', () => {
  it('passes a reminder that says when and where and nothing else', () => {
    const { body } = CLIENT_TEMPLATES.appointment_reminder!({
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

  it('keeps every shipped client template clean', () => {
    for (const [key, build] of Object.entries(CLIENT_TEMPLATES)) {
      const { subject, body } = build({
        practice: 'Stillwater', startAt: new Date('2026-09-01T19:00:00Z'), link: 'https://example.test/f/abc',
      });
      expect(indiscreetTerms(body), key).toEqual([]);
      expect(indiscreetTerms(subject ?? ''), key).toEqual([]);
    }
  });

  it('is blunt on purpose — every entry is a substring match', () => {
    expect(DENY_LIST.length).toBeGreaterThan(20);
    expect(indiscreetTerms('supervisory review')).toEqual(['supervis']);
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
