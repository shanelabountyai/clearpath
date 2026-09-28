import { randomBytes, randomUUID } from 'node:crypto';
import { auditEvent, guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { systemClock, type Clock, DAY } from '../clock';
import { PUBLIC_ACTOR } from '../clients/public-inquiry';
import { clientTarget } from '../clients/repository';
import { prisma, type Tx } from '../db';
import { Conflict, NotFound } from '../errors';
import { clientUrl, queueToClient, queueToClinician } from '../messaging/outbox';
import { alertRecipient } from '../staff/coverage';
import { localDateOf } from '../time';
import { missingLanguages, renderSubmission, validateSubmission, type Answers, type TemplateSchema } from './schema';
import { scoreSubmission, type ScoringRules } from './scoring';

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
const newToken = () => randomBytes(24).toString('base64url');

interface TemplateDraft {
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

const latestTemplate = (key: string) =>
  prisma.formTemplate.findFirst({ where: { key, published: true }, orderBy: { version: 'desc' } });

export async function issueForm(
  actor: Actor,
  input: { clientId: string; templateKey: string; expiresInDays?: number; clock?: Clock },
) {
  const clock = input.clock ?? systemClock;
  const template = await latestTemplate(input.templateKey);
  if (!template) throw new NotFound('FormTemplate');

  const client = await prisma.client.findUnique({
    where: { id: input.clientId },
    select: { language: true },
  });
  if (!client) throw new NotFound('Client');

  /**
   * Refuse to send a form the client cannot read.
   *
   * Templates are data, so no compiler stops a practice manager adding an
   * English-only question — which is the right trade for letting them revise
   * an intake without a deploy, and the wrong thing to discover at render
   * time. A blank question on a client's screen is a form they will answer
   * anyway, or abandon silently; a refusal here is a practice manager with a
   * list of field keys to translate. Named `Conflict`, not `NotFound`,
   * because the template exists and the practice can fix it.
   */
  const untranslated = missingLanguages(asSchema(template.schema))[client.language];
  if (untranslated.length) {
    throw new Conflict(
      `Template ${template.key} v${template.version} is missing this client's language for: ${untranslated.join(', ')}`,
      'template_not_translated',
    );
  }

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
          link: clientUrl(`/f/${token}`),
        },
        tx,
      );
      return request;
    },
  );
}

// ───────────────────────── the tokenized client door ─────────────────────────

/** The actor a form link stands for: the client it was issued to. */
const tokenActor = (clientId: string): Actor => ({ id: clientId, role: 'client' });

type TokenAction = { action: 'read' | 'update'; resource: 'form_request' } | { action: 'create'; resource: 'form_submission' };

/**
 * The request behind a token, or a refusal that is on the record.
 *
 * Hard rule 4 wants denials logged, and a token that does not open is one: an
 * unknown token is logged as the public (there is nobody to name), an expired
 * or spent one against the client it was issued to. Reason codes only — the
 * token itself never reaches the log, since a log row is not a place to keep
 * a working key.
 */
async function liveRequest(token: string, clock: Clock, door: TokenAction) {
  const request = await prisma.formRequest.findUnique({
    where: { token },
    // The client's language and code and nothing else about them. The page is
    // rendered in Spanish or it is not, so a leaked link discloses that either
    // way — this adds no surface, where a name would. The code is for the
    // clinician's alert, never the page.
    include: { template: true, client: { select: { language: true, code: true } } },
  });
  const refuse = async (reason: string, clientId?: string) => {
    await auditEvent(
      clientId ? tokenActor(clientId) : PUBLIC_ACTOR, door.action, door.resource,
      { resourceId: request?.id, clientId, rule: 'token', reason: `refused:${reason}`, allowed: false },
    );
  };
  // ponytail: one audit row per unknown-token hit, unthrottled. Behind the demo
  // gate that is fine; a public deployment wants the enquiry form's per-address
  // throttle in front of this before a scanner fills the table.
  if (!request) {
    await refuse('unknown_token');
    throw new NotFound('FormRequest');
  }
  if (request.status === 'submitted') {
    await refuse('already_submitted', request.clientId);
    throw new Conflict('This form has already been submitted', 'already_submitted');
  }
  if (request.expiresAt < clock.now()) {
    await refuse('expired', request.clientId);
    throw new Conflict('This link has expired', 'expired');
  }
  return request;
}

/** The `guarded` request for a live form link: the client, on their own row. */
const tokenRequest = (request: { id: string; clientId: string }, door: TokenAction) => ({
  actor: tokenActor(request.clientId),
  ...door,
  resourceId: request.id,
  clientId: request.clientId,
  target: { ownerClientId: request.clientId },
});

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
  const door = { action: 'read', resource: 'form_request' } as const;
  const request = await liveRequest(token, clock, door);

  await guarded(tokenRequest(request, door), async (tx) => {
    if (request.status === 'sent') {
      await tx.formRequest.update({
        where: { id: request.id },
        data: { status: 'started', startedAt: clock.now() },
      });
    }
  });

  return {
    name: request.template.name,
    kind: request.template.kind,
    language: request.client.language,
    schema: asSchema(request.template.schema),
    answers: (request.draftAnswers ?? {}) as Answers,
  };
}

/** Save progress. A screener asking hard questions is not a one-sitting task. */
export async function saveDraft(token: string, answers: Answers, opts: { clock?: Clock } = {}) {
  const clock = opts.clock ?? systemClock;
  const door = { action: 'update', resource: 'form_request' } as const;
  const request = await liveRequest(token, clock, door);

  await guarded(tokenRequest(request, door), (tx) =>
    tx.formRequest.update({
      where: { id: request.id },
      data: { draftAnswers: answers as object, status: 'started', startedAt: request.startedAt ?? clock.now() },
    }));
}

interface SubmitResult {
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
  const door = { action: 'create', resource: 'form_submission' } as const;
  const request = await liveRequest(token, clock, door);

  const schema = asSchema(request.template.schema);
  const errors = validateSubmission(schema, answers);
  if (errors.length) {
    throw new Conflict(
      `This form has ${errors.length} unanswered or invalid question(s)`,
      'invalid',
      errors.map((e) => e.field),
    );
  }

  const score = scoreSubmission(schema, asRules(request.template.scoring), answers);
  const signature = schema.fields.find((f) => f.type === 'signature');
  const now = clock.now();

  // Minted here so the audit row can name the submission it describes.
  const submissionId = randomUUID();

  // The client is the actor: they filled this in through their own link.
  return guarded({ ...tokenRequest(request, door), resourceId: submissionId }, async (tx) => {
    const submission = await tx.formSubmission.create({
      data: {
        id: submissionId,
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
      // Hard rule 9 on a day the treating clinician is away: the coverer (P0-5).
      const to = await alertRecipient(tx, request.clientId, localDateOf(now));
      await tx.alert.create({
        data: {
          ...to,
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
          userId: to.recipientId,
          templateKey: 'screener_alert',
          subject: 'A response needs your review',
          // Codes and a client code, never answers and never the score.
          body: `Client ${request.client.code} submitted a response flagged for review (${score.reasons.join(', ')}). Open Clearpath to read it.`,
          scheduledFor: now,
        },
        tx,
      );
    }

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
  const target = await clientTarget(clientId);

  return guarded(
    { actor, action: 'read', resource: 'form_submission', clientId, target },
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
    where: { id: submissionId }, select: { clientId: true },
  });
  if (!row) throw new NotFound('FormSubmission');

  return guarded(
    {
      actor, action: 'read', resource: 'form_submission', resourceId: submissionId,
      clientId: row.clientId, target: await clientTarget(row.clientId),
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

/**
 * Undo a mis-clicked acknowledgement (PRD 5, Q3). Its own audit row, coded, so
 * the record shows the alert went back in the queue and who put it there.
 */
export async function reopenAlert(actor: Actor, alertId: string) {
  const alert = await prisma.alert.findUnique({ where: { id: alertId } });
  if (!alert) throw new NotFound('Alert');

  return guarded(
    {
      actor, action: 'update', resource: 'alert', resourceId: alertId, clientId: alert.clientId,
      target: { recipientId: alert.recipientId }, reason: 'alert:reopened',
    },
    (tx) => tx.alert.update({ where: { id: alertId }, data: { acknowledgedAt: null } }),
  );
}
