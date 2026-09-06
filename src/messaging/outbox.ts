import { prisma, type Tx } from '../db';
import { systemClock } from '../clock';
import { minutesToHHMM, utcToZoned } from '../time';
import { ALL_DENIED, LANGUAGES, WEEKDAY_NAMES, normalise, type Language } from './language';

/**
 * Everything the practice sends a client, and the rule that governs it.
 *
 * A reminder arrives on a lock screen, in a shared inbox, on a phone somebody
 * else picks up. So it says when and where, and nothing about why. This is the
 * detail outsiders miss and clients never forget being burned by, and it is the
 * reason the practice has a messaging name ("Stillwater") distinct from its
 * legal name ("Stillwater Counseling").
 *
 * Nothing here actually sends: this file queues, and `delivery.ts` hands what it
 * queued to a `Carrier`. The only driver this repository ships is simulated, so
 * the rows are still the whole of it — what changed in P2 is that the row now
 * has a delivery state on it, and the fee reads that rather than the row.
 */

/**
 * The deny-list lives in `language.ts` now, one per language, and this checks
 * the union of all of them. A body has to be discreet to whoever picks up the
 * phone rather than only to the client — see the note at the top of that file.
 */
export class IndiscreetMessage extends Error {
  constructor(readonly terms: string[]) {
    super(`Message would disclose why the client is attending: ${terms.join(', ')}`);
    this.name = 'IndiscreetMessage';
  }
}

/** Terms from any shipped language's deny-list present in the text. */
export function indiscreetTerms(text: string): string[] {
  const haystack = normalise(text);
  return ALL_DENIED.filter((term) => haystack.includes(term));
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

interface ClientMessageContext {
  practice: string;
  startAt?: Date;
  link?: string;
  /** The number front desk answers. Only the inbound auto-reply carries it. */
  contactPhone?: string;
}

type Renderer = (c: ClientMessageContext) => { subject?: string; body: string };

/**
 * When a session is, said in the client's own language.
 *
 * The time stays 24-hour in both, which is a choice rather than an oversight:
 * `15:00` is unambiguous to a Spanish reader and to an English one, where
 * "3:00 PM" has to be translated and a mistranslated hour is a client arriving
 * at the wrong time.
 */
const whenLabel = (language: Language, startAt: Date | undefined, fallback: string): string => {
  if (!startAt) return fallback;
  const when = utcToZoned(startAt);
  return `${WEEKDAY_NAMES[language][when.weekday]} ${minutesToHHMM(when.minutes)}`;
};

/**
 * Every body the practice sends a client, in every language it can send it in.
 *
 * Keyed template-first rather than language-first so that a missing
 * translation is visible as a hole in one object rather than as a shorter list
 * three screens away — and so `templateLanguages` can answer "who can receive
 * this" without walking the whole registry.
 *
 * **A template with no body in a client's language is not sent.** Not English
 * as a fallback: an unreadable message counts as having asked, and the sweep
 * would charge somebody for not answering a question they could not read,
 * which is the exact failure this feature exists to make unreachable. The
 * cadence therefore treats an untranslated reminder the way it treats
 * `reminderPreference: 'none'` — nothing queued, nothing promoted, no fee. The
 * test below refuses a partially translated language outright, so that branch
 * is a safety net rather than a plan.
 *
 * Neutral by construction in both. Editable by the practice; still lint-gated
 * on send, and the lint is now the union of every language's list.
 */
export const CLIENT_TEMPLATES: Record<string, Partial<Record<Language, Renderer>>> = {
  // The cadence's body. It carries the client's own door, because the required
  // response is one tap on a link rather than a `YES` texted back to a short
  // code: a compulsory reply is conspicuous on a lock screen in a way the
  // deny-list cannot fix, and it would open an inbound channel nobody here can
  // safely read. Says when, where, and what to tap. Never why.
  appointment_reminder: {
    en: ({ practice, startAt, link }) => ({
      subject: 'Appointment reminder',
      body: `Appointment reminder: ${whenLabel('en', startAt, 'your appointment')}, ${practice}. Please let us know if you are coming: ${link}. The link is personal to you — please do not forward it.`,
    }),
    es: ({ practice, startAt, link }) => ({
      subject: 'Recordatorio de cita',
      body: `Recordatorio de cita: ${whenLabel('es', startAt, 'su cita')}, ${practice}. Avísenos si va a venir: ${link}. El enlace es personal — por favor no lo reenvíe.`,
    }),
  },
  appointment_confirmed: {
    en: ({ practice, startAt }) => ({
      subject: 'Appointment confirmed',
      body: `Confirmed: ${whenLabel('en', startAt, 'your appointment')}, ${practice}.`,
    }),
    es: ({ practice, startAt }) => ({
      subject: 'Cita confirmada',
      body: `Confirmada: ${whenLabel('es', startAt, 'su cita')}, ${practice}.`,
    }),
  },
  form_request: {
    en: ({ practice, link }) => ({
      subject: 'A form to complete before your visit',
      body: `${practice} has sent you a form to complete before your visit: ${link}. The link is personal to you — please do not forward it.`,
    }),
    es: ({ practice, link }) => ({
      subject: 'Un formulario para completar antes de su visita',
      body: `${practice} le ha enviado un formulario para completar antes de su visita: ${link}. El enlace es personal — por favor no lo reenvíe.`,
    }),
  },
  portal_link: {
    en: ({ practice, link }) => ({
      subject: 'Your upcoming appointments',
      body: `You can see your upcoming appointments with ${practice} here: ${link}. The link is personal to you — please do not forward it.`,
    }),
    es: ({ practice, link }) => ({
      subject: 'Sus próximas citas',
      body: `Puede ver sus próximas citas con ${practice} aquí: ${link}. El enlace es personal — por favor no lo reenvíe.`,
    }),
  },
  /**
   * P1-3. The answer to a message this system cannot read.
   *
   * It is the one client-facing body that carries phone numbers, and it has to:
   * a reply that reached nobody would be worse than no inbound channel at all,
   * because the client believes they have told somebody.
   *
   * Note what neither version says. "Crisis line" is on the deny-list — it
   * names why somebody might be attending, on a lock screen, which is exactly
   * the disclosure the list exists to stop — so both say what the number is for
   * instead of what it is called. `crisis` is spelled identically in Spanish
   * and denied by both lists, so the constraint did not need re-deriving; the
   * Spanish body was written to it from the start rather than translated into
   * a violation and then fixed.
   *
   * 988 is the United States Suicide & Crisis Lifeline, and it is the only real
   * external number in this codebase. A placeholder here would be a plausible
   * -looking dead end on the one path where that matters most. It takes calls
   * and texts in Spanish, which is why the Spanish body can point at the same
   * number rather than needing one of its own.
   */
  inbound_unparsed: {
    en: ({ contactPhone }) => ({
      subject: 'We received your message',
      body:
        `We cannot read replies to this number. Please call us on ${contactPhone}. `
        + 'If you need urgent help right now, call or text 988 at any hour.',
    }),
    es: ({ contactPhone }) => ({
      subject: 'Recibimos su mensaje',
      body:
        `No podemos leer las respuestas a este número. Por favor llámenos al ${contactPhone}. `
        + 'Si necesita ayuda urgente ahora mismo, llame o envíe un mensaje al 988 a cualquier hora.',
    }),
  },
  appointment_cancelled: {
    en: ({ practice }) => ({
      subject: 'Appointment cancelled',
      body: `Your appointment with ${practice} has been cancelled. Reply to this message to rebook.`,
    }),
    es: ({ practice }) => ({
      subject: 'Cita cancelada',
      body: `Su cita con ${practice} ha sido cancelada. Responda a este mensaje para reservar otra.`,
    }),
  },
};

/** The languages a template can actually be sent in. */
export const templateLanguages = (templateKey: string): Language[] =>
  LANGUAGES.filter((l) => CLIENT_TEMPLATES[templateKey]?.[l] !== undefined);

/**
 * Whether the practice can put this message in front of this client at all.
 *
 * Pure, and exported because the cadence has to ask *before* it opens a
 * transaction: a reminder it cannot render is a client it may not charge, and
 * that has to be decided in the same breath as the other eligibility rules
 * rather than discovered halfway through a write.
 */
export const canRender = (templateKey: string, language: Language): boolean =>
  CLIENT_TEMPLATES[templateKey]?.[language] !== undefined;

async function practiceVoice(db: Tx | typeof prisma) {
  const s = await db.practiceSettings.findUnique({
    where: { id: 1 }, select: { messagingName: true, contactPhone: true },
  });
  return { practice: s?.messagingName ?? 'Stillwater', contactPhone: s?.contactPhone ?? '555-0100' };
}

interface QueueToClient {
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
    select: { reminderPreference: true, language: true },
  });
  if (!client || client.reminderPreference === 'none') return null;

  // No body in this client's language means no message. Not an English
  // fallback: a message they cannot read would still count as the practice
  // having asked, and the sweep would charge them for not answering it. The
  // same shape as `reminderPreference: 'none'` above, for the same reason.
  const render = CLIENT_TEMPLATES[input.templateKey]?.[client.language];
  if (!render) return null;

  const { subject, body } = render({
    ...(await practiceVoice(db)),
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
      // What this body is actually written in, recorded rather than left to be
      // re-derived from the client's record later. The record is a live field
      // that front desk can correct; the message is a thing that was already
      // said, and after a correction the two disagree — which is precisely the
      // moment somebody needs to know which language the client was asked in.
      language: client.language,
      scheduledFor: input.scheduledFor,
      // The moment it stops being worth sending. A reminder is a message about
      // an hour, and "are you coming Tuesday" delivered on Wednesday teaches
      // the client that this practice's messages are not worth opening — which
      // is the signal the whole fee depends on. Messages with no hour behind
      // them (a form, a portal link) fall back to the carrier's own week.
      expiresAt: input.startAt ?? null,
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
