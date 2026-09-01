import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { Conflict, Forbidden } from '../errors.js';
import { actor, makeClient, makeUser, resetDb, settings } from '../test/harness.js';
import { fixedClock, DAY } from '../clock.js';
import { consentToTreat, wellbeingCheckIn } from './fixtures.js';
import {
  acknowledgeAlert, formStatus, getSubmission, issueForm, listSubmissions,
  myAlerts, openForm, publishTemplate, saveDraft, submitForm,
} from './service.js';

let admin: Awaited<ReturnType<typeof makeUser>>;
let desk: Awaited<ReturnType<typeof makeUser>>;
let therapist: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;
let client: Awaited<ReturnType<typeof makeClient>>;

const zeros = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`item_${i + 1}`, 0]));

beforeEach(async () => {
  await resetDb();
  await settings({ messagingName: 'Stillwater' });
  admin = await makeUser('admin');
  desk = await makeUser('front_desk');
  therapist = await makeUser('therapist');
  other = await makeUser('therapist');
  client = await makeClient(therapist.id);
});
afterAll(() => prisma.$disconnect());

const publishScreener = () =>
  publishTemplate(actor(admin), {
    key: 'wellbeing-check-in', name: 'Wellbeing Check-In', kind: 'screener', ...wellbeingCheckIn,
  });

const issueScreener = async () => {
  await publishScreener();
  return issueForm(actor(desk), { clientId: client.id, templateKey: 'wellbeing-check-in' });
};

describe('template versioning', () => {
  it('numbers versions and never rewrites an old one', async () => {
    const v1 = await publishScreener();
    const v2 = await publishScreener();
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(await prisma.formTemplate.count()).toBe(2);
  });

  it('binds a submission to the version answered, not the latest', async () => {
    const v1 = await publishScreener();
    const request = await issueForm(actor(desk), { clientId: client.id, templateKey: 'wellbeing-check-in' });
    await publishScreener(); // v2 lands while the client has the link open
    const { submissionId } = await submitForm(request.token, zeros);

    const stored = await prisma.formSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(stored.templateId).toBe(v1.id);

    const rendered = await getSubmission(actor(therapist), submissionId);
    expect(rendered.template.version).toBe(1);
    expect(rendered.orphans).toEqual([]);
  });

  it('is not front desk business to publish', async () => {
    await expect(
      publishTemplate(actor(desk), { key: 'x', name: 'X', kind: 'intake', schema: { fields: [] } }),
    ).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('the tokenized link', () => {
  it('opens to the form and nothing about the client', async () => {
    const request = await issueScreener();
    const form = await openForm(request.token);
    expect(form.name).toBe('Wellbeing Check-In');
    expect(JSON.stringify(form)).not.toContain(client.lastName);
    expect(JSON.stringify(form)).not.toContain(therapist.name);
  });

  it('is resumable', async () => {
    const request = await issueScreener();
    await saveDraft(request.token, { item_1: 2 });
    expect((await openForm(request.token)).answers).toEqual({ item_1: 2 });
  });

  it('expires', async () => {
    const request = await issueScreener();
    const later = fixedClock(new Date(Date.now() + 40 * DAY));
    await expect(openForm(request.token, { clock: later })).rejects.toMatchObject({ code: 'expired' });
    await expect(submitForm(request.token, zeros, { clock: later })).rejects.toMatchObject({ code: 'expired' });
  });

  it('cannot be submitted twice', async () => {
    const request = await issueScreener();
    await submitForm(request.token, zeros);
    await expect(submitForm(request.token, zeros)).rejects.toMatchObject({ code: 'already_submitted' });
  });

  it('rejects an invalid submission without saving anything', async () => {
    const request = await issueScreener();
    await expect(submitForm(request.token, { item_1: 9 })).rejects.toMatchObject({ code: 'invalid' });
    expect(await prisma.formSubmission.count()).toBe(0);
  });

  it('is opaque and unguessable', async () => {
    const request = await issueScreener();
    expect(request.token).toHaveLength(32);
    expect(request.token).not.toContain(client.id);
    expect(request.token).not.toContain(client.code);
  });

  it('queues a discreet message to the client with the link', async () => {
    await issueScreener();
    const [msg] = await prisma.outboxMessage.findMany({ where: { templateKey: 'form_request' } });
    expect(msg!.body).toContain('/f/');
    expect(msg!.body.toLowerCase()).not.toContain('screener');
    expect(msg!.body.toLowerCase()).not.toContain('counseling');
  });
});

describe('risk alerts', () => {
  const flagged = { ...zeros, item_9: 2 };
  const high = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`item_${i + 1}`, i === 8 ? 0 : 2]));

  it('raise exactly one alert, to exactly one person, on a critical item', async () => {
    const request = await issueScreener();
    const result = await submitForm(request.token, flagged);
    expect(result.needsReview).toBe(true);
    expect(result.reasons).toEqual(['critical:item_9']);

    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ recipientId: therapist.id, kind: 'screener_critical_item' });
  });

  it('raise one on a threshold crossing', async () => {
    const request = await issueScreener();
    const result = await submitForm(request.token, high);
    expect(result.reasons).toEqual(['threshold:moderately_severe']); // 8 items at 2 = 16
    expect((await prisma.alert.findMany())[0]).toMatchObject({ kind: 'screener_threshold' });
  });

  it('raise none for an unremarkable submission', async () => {
    const request = await issueScreener();
    await submitForm(request.token, zeros);
    expect(await prisma.alert.count()).toBe(0);
    expect(await prisma.outboxMessage.count({ where: { templateKey: 'screener_alert' } })).toBe(0);
  });

  it('carry reason codes to the clinician inbox, never answers or scores', async () => {
    const request = await issueScreener();
    await submitForm(request.token, { ...flagged, anything_else: 'my brother died in June' });
    const [msg] = await prisma.outboxMessage.findMany({ where: { templateKey: 'screener_alert' } });
    expect(msg!.userId).toBe(therapist.id);
    expect(msg!.body).toContain('critical:item_9');
    expect(msg!.body).not.toContain('brother');
    expect(msg!.body).not.toMatch(/\b\d+\s*(points|score)/i);
  });

  it('are readable only by their recipient', async () => {
    const request = await issueScreener();
    await submitForm(request.token, flagged);

    expect(await myAlerts(actor(therapist))).toHaveLength(1);
    expect(await myAlerts(actor(other))).toHaveLength(0);
    await expect(myAlerts(actor(desk))).rejects.toBeInstanceOf(Forbidden);
    await expect(myAlerts(actor(admin, 'checking on things'))).rejects.toBeInstanceOf(Forbidden);
  });

  it('cannot be acknowledged by anyone but their recipient', async () => {
    const request = await issueScreener();
    await submitForm(request.token, flagged);
    const alertRow = await prisma.alert.findFirstOrThrow();

    await expect(acknowledgeAlert(actor(other), alertRow.id)).rejects.toBeInstanceOf(Forbidden);
    const done = await acknowledgeAlert(actor(therapist), alertRow.id);
    expect(done.acknowledgedAt).not.toBeNull();
    expect(await myAlerts(actor(therapist))).toHaveLength(0);
  });

  it('appear in the audit stream as an event, without the response content', async () => {
    const request = await issueScreener();
    await submitForm(request.token, { ...flagged, anything_else: 'something private' });
    const rows = await prisma.auditEvent.findMany({ where: { resource: 'form_submission' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorRole: 'client', action: 'create', clientId: client.id });
    expect(JSON.stringify(rows)).not.toContain('something private');
  });

  it('roll back with the submission if anything in the transaction fails', async () => {
    const request = await issueScreener();
    await prisma.client.update({ where: { id: client.id }, data: { treatingClinicianId: therapist.id } });
    await prisma.$executeRaw`ALTER TABLE "Alert" ADD CONSTRAINT tmp_fail CHECK (false)`;
    await expect(submitForm(request.token, flagged)).rejects.toBeTruthy();
    await prisma.$executeRaw`ALTER TABLE "Alert" DROP CONSTRAINT tmp_fail`;
    expect(await prisma.formSubmission.count()).toBe(0);
    expect(await prisma.formRequest.findUniqueOrThrow({ where: { token: request.token } })).toMatchObject({ status: 'sent', submittedAt: null });
  });
});

describe('who sees what', () => {
  it('front desk sees that a form was submitted, never what is in it', async () => {
    const request = await issueScreener();
    await submitForm(request.token, { ...zeros, item_9: 3 });

    const status = await formStatus(actor(desk), client.id);
    expect(status[0]).toMatchObject({ status: 'submitted' });
    expect(JSON.stringify(status)).not.toContain('item_9');
    expect(JSON.stringify(status)).not.toContain('critical');

    await expect(listSubmissions(actor(desk), client.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it('the treating clinician sees content and score', async () => {
    const request = await issueScreener();
    const { submissionId } = await submitForm(request.token, { ...zeros, item_1: 3, item_2: 3, item_3: 3, item_4: 3 });
    const full = await getSubmission(actor(therapist), submissionId);
    expect(full.totalScore).toBe(12);
    expect(full.band?.id).toBe('moderate');
    expect(full.fields.length).toBeGreaterThan(9);
  });

  it('another clinician sees nothing, and the denial is logged', async () => {
    const request = await issueScreener();
    const { submissionId } = await submitForm(request.token, zeros);
    await expect(getSubmission(actor(other), submissionId)).rejects.toBeInstanceOf(Forbidden);
    const [row] = await prisma.auditEvent.findMany({ where: { allowed: false, resource: 'form_submission' } });
    expect(row).toMatchObject({ actorId: other.id, clientId: client.id });
  });

  it('break-glass does not reach a screener response', async () => {
    const request = await issueScreener();
    const { submissionId } = await submitForm(request.token, zeros);
    await expect(getSubmission(actor(admin, 'urgent'), submissionId)).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('consent', () => {
  it('captures a typed-name signature and a timestamp', async () => {
    await publishTemplate(actor(admin), {
      key: 'consent-to-treat', name: 'Consent to Treatment', kind: 'consent', ...consentToTreat,
    });
    const request = await issueForm(actor(desk), { clientId: client.id, templateKey: 'consent-to-treat' });
    const { submissionId } = await submitForm(request.token, {
      read_policies: true, understand_limits: true, cancellation_policy: true, signature: 'Test Client 001',
    });
    const stored = await prisma.formSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(stored.signatureName).toBe('Test Client 001');
    expect(stored.signedAt).not.toBeNull();
  });
});
