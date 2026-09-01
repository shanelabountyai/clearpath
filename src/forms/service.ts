import { randomBytes } from 'node:crypto';
import { auditEvent, guarded } from '../auth/guard.js';
import type { Actor } from '../auth/permissions.js';
import { systemClock, type Clock, DAY } from '../clock.js';
import { prisma, type Tx } from '../db.js';
import { Conflict, NotFound } from '../errors.js';
import { queueToClient, queueToClinician } from '../messaging/outbox.js';
import { renderSubmission, validateSubmission, type Answers, type TemplateSchema } from './schema.js';
import { scoreSubmission, type ScoringRules } from './scoring.js';

/**
 * Forms, from template revision through tokenized submission to the private
 * alert a flagged screener produces.
 *
 * The two rules that shape everything here:
 *
 *  1. A submission binds to the template *version* it was answered on. Editing
 *     a template creates a new version; it never mutates the one past answers
 *     point at. Scoring rules version with it, so history is never re-scored
 *     against an instrument the client did not complete.
 *  2. A flag reaches the treating clinician and nobody else. Not a shared
 *     inbox, not front desk, not a supervisor. The alert carries reason codes.
 */

const asSchema = (v: unknown) => v as TemplateSchema;
const asRules = (v: unknown) => (v ?? null) as ScoringRules | null;

/** 32 bytes of randomness. Opaque, carries no client identifier. */
export const newToken = () => randomBytes(24).toString('base64url');

export interface TemplateDraft {
  key: string;
  name: string;
  kind: 'intake' | 'consent' | 'screener';
  schema: TemplateSchema;
  scoring?: ScoringRules | null;
}

/**
 * Publish a new version. Past submissions keep pointing at the version they
 * were answered on, which is the whole reason this creates rather than updates.
 */
export async function publishTemplate(actor: Actor, draft: TemplateDraft) {
  const latest = await prisma.formTemplate.findFirst({
    where: { key: draft.key },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;

  return guarded(
    { actor, action: 'create', resource: 'form_template' },
    (tx) =>
      tx.formTemplate.create({
        data: {
          key: draft.key, name: draft.name, kind: draft.kind, version, published: true,
          schema: draft.schema as object,
          scoring: (draft.scoring ?? undefined) as object | undefined,
        },
      }),
  );
}

export const latestTemplate = (key: string) =>
  prisma.formTemplate.findFirst({ where: { key, published: true }, orderBy: { version: 'desc' } });

export async function issueForm(
  actor: Actor,
  input: { clientId: string; templateKey: string; expiresInDays?: number; clock?: Clock; baseUrl?: string },
) {
  const clock = input.clock ?? systemClock;
  const template = await latestTemplate(input.templateKey);
  if (!template) throw new NotFound('FormTemplate');

  const token = newToken();
  const expiresAt = new Date(clock.now().getTime() + (input.expiresInDays ?? 30) * DAY);

  return guarded(
    { actor, action: 'create', resource: 'form_request', clientId: input.clientId },
    async (tx) => {
      const request = await tx.formRequest.create({
        data: { clientId: input.clientId, templateId: template.id, token, expiresAt },
      });
      await queueToClient(
        {
          clientId: input.clientId,
          templateKey: 'form_request',
          scheduledFor: clock.now(),
          link: `${input.baseUrl ?? 'http://localhost:3700'}/f/${token}`,
        },
        tx,
      );
      return request;
    },
  );
}

// ───────────────────────── the tokenized client door ─────────────────────────

/**
 * Everything reachable with a token, and nothing more: the form itself and the
 * client's own saved answers.
 *
 * Note what is absent. No name, no clinician, no appointment, no other form. A
 * link that leaks — forwarded, screenshotted, left open on a shared laptop —
 * discloses that somebody was asked these questions, and stops there.
 */
export async function openForm(token: string, opts: { clock?: Clock } = {}) {
  const clock = opts.clock ?? systemClock;
  const request = await prisma.formRequest.findUnique({
    where: { token },
    include: { template: true },
  });
  if (!request) throw new NotFound('FormRequest');
  if (request.status === 'submitted') throw new Conflict('This form has already been submitted', 'already_submitted');
  if (request.expiresAt < clock.now()) throw new Conflict('This link has expired', 'expired');

  if (request.status === 'sent') {
    await prisma.formRequest.update({
      where: { id: request.id },
      data: { status: 'started', startedAt: clock.now() },
    });
  }

  return {
    name: request.template.name,
    kind: request.template.kind,
    schema: asSchema(request.template.schema),
    answers: (request.draftAnswers ?? {}) as Answers,
  };
}

/** Save progress. A screener asking hard questions is not a one-sitting task. */
export async function saveDraft(token: string, answers: Answers, opts: { clock?: Clock } = {}) {
  const clock = opts.clock ?? systemClock;
  const request = await prisma.formRequest.findUnique({ where: { token } });
  if (!request) throw new NotFound('FormRequest');
  if (request.status === 'submitted') throw new Conflict('This form has already been submitted', 'already_submitted');
  if (request.expiresAt < clock.now()) throw new Conflict('This link has expired', 'expired');

  await prisma.formRequest.update({
    where: { id: request.id },
    data: { draftAnswers: answers as object, status: 'started', startedAt: request.startedAt ?? clock.now() },
  });
}

export interface SubmitResult {
  submissionId: string;
  needsReview: boolean;
  /** Reason codes. Safe to log; deliberately not the score or the answers. */
  reasons: string[];
}

/**
 * Submit, score, and — if the submission crosses a threshold or flags a
 * critical item — raise one private alert to one person, all in one
 * transaction. A scored screener that half-saved is a client who answered a
 * question about self-harm into a void.
 */
export async function submitForm(
  token: string,
  answers: Answers,
  opts: { clock?: Clock } = {},
): Promise<SubmitResult> {
  const clock = opts.clock ?? systemClock;
  const request = await prisma.formRequest.findUnique({
    where: { token },
    include: { template: true, client: { select: { id: true, treatingClinicianId: true, code: true } } },
  });
  if (!request) throw new NotFound('FormRequest');
  if (request.status === 'submitted') throw new Conflict('This form has already been submitted', 'already_submitted');
  if (request.expiresAt < clock.now()) throw new Conflict('This link has expired', 'expired');

  const schema = asSchema(request.template.schema);
  const errors = validateSubmission(schema, answers);
  if (errors.length) throw new Conflict(`This form has ${errors.length} unanswered or invalid question(s)`, 'invalid');

  const score = scoreSubmission(schema, asRules(request.template.scoring), answers);
  const signature = schema.fields.find((f) => f.type === 'signature');
  const now = clock.now();

  return prisma.$transaction(async (tx) => {
    const submission = await tx.formSubmission.create({
      data: {
        requestId: request.id,
        clientId: request.clientId,
        templateId: request.templateId,
        answers: answers as object,
        totalScore: asRules(request.template.scoring) ? score.total : null,
        needsReview: score.needsReview,
        reviewReasons: score.reasons,
        signatureName: signature ? String(answers[signature.key] ?? '') : null,
        signedAt: signature ? now : null,
      },
    });

    await tx.formRequest.update({
      where: { id: request.id },
      data: { status: 'submitted', submittedAt: now, draftAnswers: undefined },
    });

    if (score.needsReview) {
      await tx.alert.create({
        data: {
          recipientId: request.client.treatingClinicianId,
          clientId: request.clientId,
          submissionId: submission.id,
          kind: score.reasons.some((r) => r.startsWith('critical:'))
            ? 'screener_critical_item'
            : 'screener_threshold',
          reasons: score.reasons,
        },
      });
      await queueToClinician(
        {
          userId: request.client.treatingClinicianId,
          templateKey: 'screener_alert',
          subject: 'A response needs your review',
          // Codes and a client code, never answers and never the score.
          body: `Client ${request.client.code} submitted a response flagged for review (${score.reasons.join(', ')}). Open Clearpath to read it.`,
          scheduledFor: now,
        },
        tx,
      );
    }

    // The client is the actor: they filled this in through their own link.
    await auditEvent(
      { id: request.clientId, role: 'client' },
      'create', 'form_submission',
      { resourceId: submission.id, clientId: request.clientId, rule: 'token' },
      tx as Tx,
    );

    return { submissionId: submission.id, needsReview: score.needsReview, reasons: score.reasons };
  });
}

// ──────────────────────────── the staff surfaces ────────────────────────────

/**
 * "Sent / submitted ✓" and nothing else. This is the front-desk surface: they
 * chase a form without ever seeing an answer.
 */
export async function formStatus(actor: Actor, clientId: string) {
  return guarded(
    { actor, action: 'read', resource: 'form_request', clientId },
    (tx) =>
      tx.formRequest.findMany({
        where: { clientId },
        select: {
          id: true, status: true, sentAt: true, submittedAt: true, expiresAt: true,
          template: { select: { name: true, kind: true, version: true } },
        },
        orderBy: { sentAt: 'desc' },
      }),
  );
}

/** Content and scores. Clinical: the treating clinician only. */
export async function listSubmissions(actor: Actor, clientId: string) {
  const client = await prisma.client.findUnique({
    where: { id: clientId }, select: { treatingClinicianId: true },
  });
  if (!client) throw new NotFound('Client');

  return guarded(
    {
      actor, action: 'read', resource: 'form_submission', clientId,
      target: { clinicianId: client.treatingClinicianId },
    },
    (tx) =>
      tx.formSubmission.findMany({
        where: { clientId },
        select: {
          id: true, createdAt: true, totalScore: true, needsReview: true, reviewReasons: true,
          template: { select: { name: true, kind: true, version: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
  );
}

/** One submission, rendered against the version it was answered on. */
export async function getSubmission(actor: Actor, submissionId: string) {
  const row = await prisma.formSubmission.findUnique({
    where: { id: submissionId },
    select: { clientId: true, client: { select: { treatingClinicianId: true } } },
  });
  if (!row) throw new NotFound('FormSubmission');

  return guarded(
    {
      actor, action: 'read', resource: 'form_submission', resourceId: submissionId,
      clientId: row.clientId, target: { clinicianId: row.client.treatingClinicianId },
    },
    async (tx) => {
      const s = await tx.formSubmission.findUniqueOrThrow({
        where: { id: submissionId },
        include: { template: true },
      });
      const schema = asSchema(s.template.schema);
      const rules = asRules(s.template.scoring);
      return {
        id: s.id,
        submittedAt: s.createdAt,
        template: { name: s.template.name, kind: s.template.kind, version: s.template.version },
        totalScore: s.totalScore,
        band: rules ? scoreSubmission(schema, rules, s.answers as Answers).band : null,
        needsReview: s.needsReview,
        reviewReasons: s.reviewReasons,
        signatureName: s.signatureName,
        ...renderSubmission(schema, s.answers as Answers),
      };
    },
  );
}

// ─────────────────────────────── private alerts ───────────────────────────────

/** A clinician's own alerts. There is no surface that shows anyone else's. */
export async function myAlerts(actor: Actor, opts: { includeAcknowledged?: boolean } = {}) {
  return guarded(
    { actor, action: 'read', resource: 'alert', target: { recipientId: actor.id } },
    (tx) =>
      tx.alert.findMany({
        where: {
          recipientId: actor.id,
          ...(opts.includeAcknowledged ? {} : { acknowledgedAt: null }),
        },
        select: {
          id: true, kind: true, reasons: true, createdAt: true, acknowledgedAt: true,
          clientId: true, submissionId: true,
          client: { select: { code: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
  );
}

export async function acknowledgeAlert(actor: Actor, alertId: string, opts: { clock?: Clock } = {}) {
  const alert = await prisma.alert.findUnique({ where: { id: alertId } });
  if (!alert) throw new NotFound('Alert');

  return guarded(
    {
      actor, action: 'update', resource: 'alert', resourceId: alertId, clientId: alert.clientId,
      target: { recipientId: alert.recipientId },
    },
    (tx) =>
      tx.alert.update({
        where: { id: alertId },
        data: { acknowledgedAt: (opts.clock ?? systemClock).now() },
      }),
  );
}
