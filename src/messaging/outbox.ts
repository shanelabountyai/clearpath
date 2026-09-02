import { prisma, type Tx } from '../db';
import { systemClock } from '../clock';
import { minutesToHHMM, utcToZoned, WEEKDAYS } from '../time';

/**
 * Everything the practice sends a client, and the rule that governs it.
 *
 * A reminder arrives on a lock screen, in a shared inbox, on a phone somebody
 * else picks up. So it says when and where, and nothing about why. This is the
 * detail outsiders miss and clients never forget being burned by, and it is the
 * reason the practice has a messaging name ("Stillwater") distinct from its
 * legal name ("Stillwater Counseling").
 *
 * Nothing here actually sends. Rows are the stub.
 */

/**
 * Words that must never reach a client-facing message. Substring matched and
 * case-insensitive, so "Counseling", "counsellor" and "PSYCHIATRY" all fail.
 *
 * Deliberately blunt: a false positive costs somebody a rewrite, a false
 * negative costs a client their privacy.
 */
export const DENY_LIST = [
  'therapy', 'therapist', 'therapeutic',
  'counseling', 'counselling', 'counselor', 'counsellor',
  'psychiatr', 'psycholog', 'psychotherapy',
  'mental health', 'behavioral health', 'behavioural health',
  'depression', 'depressive', 'anxiety', 'trauma', 'ptsd', 'bipolar',
  'addiction', 'substance', 'suicide', 'self-harm', 'crisis',
  'diagnosis', 'diagnostic', 'treatment plan', 'clinical',
  'intake', 'screener', 'screening', 'assessment',
  'supervis', 'progress note', 'process note',
] as const;

export class IndiscreetMessage extends Error {
  constructor(readonly terms: string[]) {
    super(`Message would disclose why the client is attending: ${terms.join(', ')}`);
    this.name = 'IndiscreetMessage';
  }
}

/** Terms from the deny-list present in the text. */
export function indiscreetTerms(text: string): string[] {
  const haystack = text.toLowerCase();
  return DENY_LIST.filter((term) => haystack.includes(term));
}

/**
 * The gate every client-facing body passes. Called at send time rather than at
 * template-edit time as well, because a template with a placeholder is only
 * dangerous once something is substituted into it.
 */
export function assertDiscreet(text: string): void {
  const terms = indiscreetTerms(text);
  if (terms.length) throw new IndiscreetMessage(terms);
}

export interface ClientMessageContext {
  practice: string;
  startAt?: Date;
  link?: string;
}

/** Neutral by construction. Editable by the practice; still lint-gated on send. */
export const CLIENT_TEMPLATES: Record<string, (c: ClientMessageContext) => { subject?: string; body: string }> = {
  appointment_reminder: ({ practice, startAt }) => {
    const when = startAt ? utcToZoned(startAt) : null;
    const label = when ? `${WEEKDAYS[when.weekday]} ${minutesToHHMM(when.minutes)}` : 'your appointment';
    return {
      subject: 'Appointment reminder',
      body: `Appointment reminder: ${label}, ${practice}. Reply to this message to change it.`,
    };
  },
  appointment_confirmed: ({ practice, startAt }) => {
    const when = startAt ? utcToZoned(startAt) : null;
    const label = when ? `${WEEKDAYS[when.weekday]} ${minutesToHHMM(when.minutes)}` : 'your appointment';
    return { subject: 'Appointment confirmed', body: `Confirmed: ${label}, ${practice}.` };
  },
  form_request: ({ practice, link }) => ({
    subject: 'A form to complete before your visit',
    body: `${practice} has sent you a form to complete before your visit: ${link}. The link is personal to you — please do not forward it.`,
  }),
  appointment_cancelled: ({ practice }) => ({
    subject: 'Appointment cancelled',
    body: `Your appointment with ${practice} has been cancelled. Reply to this message to rebook.`,
  }),
};

async function practiceName(db: Tx | typeof prisma): Promise<string> {
  const s = await db.practiceSettings.findUnique({ where: { id: 1 }, select: { messagingName: true } });
  return s?.messagingName ?? 'Stillwater';
}

export interface QueueToClient {
  clientId: string;
  templateKey: keyof typeof CLIENT_TEMPLATES;
  scheduledFor: Date;
  startAt?: Date;
  link?: string;
}

/**
 * Queue a message to a client. Honours their reminder preference — "none" is a
 * real setting some clients need, and it means none, not fewer.
 */
export async function queueToClient(input: QueueToClient, tx?: Tx) {
  const db = tx ?? prisma;
  const client = await db.client.findUnique({
    where: { id: input.clientId },
    select: { reminderPreference: true },
  });
  if (!client || client.reminderPreference === 'none') return null;

  const { subject, body } = CLIENT_TEMPLATES[input.templateKey]!({
    practice: await practiceName(db),
    startAt: input.startAt,
    link: input.link,
  });
  assertDiscreet(body);
  if (subject) assertDiscreet(subject);

  return db.outboxMessage.create({
    data: {
      clientId: input.clientId,
      channel: client.reminderPreference,
      templateKey: input.templateKey,
      subject,
      body,
      scheduledFor: input.scheduledFor,
    },
  });
}

/**
 * Queue a message to a clinician's own inbox. Not client-facing, so the
 * deny-list does not apply — but it still carries reason codes and ids, never
 * a client's answers.
 */
export async function queueToClinician(
  input: { userId: string; templateKey: string; subject: string; body: string; scheduledFor?: Date },
  tx?: Tx,
) {
  const db = tx ?? prisma;
  return db.outboxMessage.create({
    data: {
      userId: input.userId,
      channel: 'email',
      templateKey: input.templateKey,
      subject: input.subject,
      body: input.body,
      scheduledFor: input.scheduledFor ?? systemClock.now(),
    },
  });
}
