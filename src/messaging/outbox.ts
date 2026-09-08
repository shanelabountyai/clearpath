import { prisma, type Tx } from '../db';
import { systemClock } from '../clock';
import { LANGUAGES, whenLabel as localizedWhen, type Language } from '../strings';

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
 * The language type is shared with the portal (`src/strings.ts`), because the
 * rule it encodes is not a messaging rule. Re-exported here so the deny-list
 * and the templates below still read as one unit with it.
 *
 * A body is discreet because a deny-list says so, and a deny-list is a list of
 * words in a language. A Spanish reminder checked against the English list is
 * not "mostly checked": `su cita de terapia` clears the gate outright, and the
 * one control standing between a client and a lock-screen disclosure reports
 * success while doing nothing. That is worse than having no gate, because the
 * send succeeds and nobody is told.
 *
 * So adding a language here is not a translation job with a lint bolted on.
 * The templates and the terms are a single unit, and `Record<Language, ...>`
 * on both is what makes the compiler refuse the half of it that ships bodies
 * without the half that reads them.
 */
export type { Language } from '../strings';
export { LANGUAGES } from '../strings';

/**
 * Lowercase, and drop the accents.
 *
 * `Depresión`.toLowerCase() is `depresión`, which does not contain
 * `depresion`, so a case-folding-only gate passes the accented spelling of
 * every term on the list — which is the spelling anyone actually writes. The
 * inbound classifier normalises with this same function for the mirror-image
 * reason: it strips everything that is not `a-z`, so `sí` arrives as `s`
 * unless the accent is folded into the letter first rather than deleted with
 * it.
 */
export const fold = (text: string): string =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Words that must never reach a client-facing message, per language. Substring
 * matched against the folded text, so "Counseling", "counsellor", "PSYCHIATRY"
 * and "Depresión" all fail.
 *
 * Deliberately blunt: a false positive costs somebody a rewrite, a false
 * negative costs a client their privacy. Entries are written folded — no
 * accents, lowercase — because that is the form they are compared in, and a
 * term carrying an accent would silently never match anything.
 */
export const DENY_LISTS: Record<Language, readonly string[]> = {
  en: [
    'therapy', 'therapist', 'therapeutic',
    'counseling', 'counselling', 'counselor', 'counsellor',
    'psychiatr', 'psycholog', 'psychotherapy',
    'mental health', 'behavioral health', 'behavioural health',
    'depression', 'depressive', 'anxiety', 'trauma', 'ptsd', 'bipolar',
    'addiction', 'substance', 'suicide', 'self-harm', 'crisis',
    'diagnosis', 'diagnostic', 'treatment plan', 'clinical',
    'intake', 'screener', 'screening', 'assessment',
    'supervis', 'progress note', 'process note',
  ],
  // Stems, not whole words, for the same reason the English list is: `terapia`
  // catches `terapias` and `terapia de pareja`, and `psicolog` catches
  // `psicólogo`, `psicóloga` and `psicológica` in one entry.
  es: [
    'terapia', 'terapeut', 'psicoterapia',
    'consejer', 'psiquiatr', 'psicolog',
    'salud mental', 'salud conductual', 'salud emocional',
    'depresion', 'depresiv', 'ansiedad', 'trauma', 'tept', 'bipolar',
    'adiccion', 'adicto', 'sustancia', 'suicid', 'autolesion', 'crisis',
    'diagnostic', 'plan de tratamiento', 'clinica', 'clinico',
    'admision', 'evaluacion', 'cuestionario', 'tamizaje',
    'supervis', 'nota de progreso', 'nota de proceso',
  ],
};

export class IndiscreetMessage extends Error {
  constructor(readonly terms: string[]) {
    super(`Message would disclose why the client is attending: ${terms.join(', ')}`);
    this.name = 'IndiscreetMessage';
  }
}

/**
 * Terms present in the text, from every language's list at once.
 *
 * Not the client's own language, on purpose. The gate does not need to know
 * who is reading — a body is one string, it is routinely a mix (a Spanish
 * template around an English practice name), and the language a message is
 * *read* in is not a fact this system holds anyway. Checking all of them is
 * strictly stronger, costs a few `includes` calls, and means adding a language
 * can never weaken the gate for the ones already shipping.
 */
export function indiscreetTerms(text: string): string[] {
  const haystack = fold(text);
  const hits = new Set<string>();
  for (const language of LANGUAGES) {
    for (const term of DENY_LISTS[language]) if (haystack.includes(term)) hits.add(term);
  }
  return [...hits];
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
  /** The practice's own line, for the one template that has to name a number. */
  phone: string;
  startAt?: Date;
  link?: string;
}

export type TemplateKey =
  | 'appointment_reminder'
  | 'appointment_confirmed'
  | 'form_request'
  | 'portal_link'
  | 'appointment_cancelled'
  | 'inbound_unparsed_reply';

type Build = (c: ClientMessageContext) => { subject?: string; body: string };

const whenLabel = (language: Language, startAt: Date | undefined, fallback: string): string =>
  startAt ? localizedWhen(language, startAt) : fallback;

/**
 * Neutral by construction, in every language. Editable by the practice; still
 * lint-gated on send.
 *
 * `Record<Language, Record<TemplateKey, Build>>` is the whole enforcement
 * mechanism: a new language does not compile until it answers for all six
 * bodies, and it does not pass its tests until `DENY_LISTS` answers for it too.
 */
export const CLIENT_TEMPLATES: Record<Language, Record<TemplateKey, Build>> = {
  en: {
    // The cadence's body. It carries the client's own door, because the required
    // response is one tap on a link rather than a `YES` texted back to a short
    // code: a compulsory reply is conspicuous on a lock screen in a way the
    // deny-list cannot fix, and it would open an inbound channel nobody here can
    // safely read. Says when, where, and what to tap. Never why.
    appointment_reminder: ({ practice, startAt, link }) => ({
      subject: 'Appointment reminder',
      body: `Appointment reminder: ${whenLabel('en', startAt, 'your appointment')}, ${practice}. Please let us know if you are coming: ${link}. The link is personal to you — please do not forward it.`,
    }),
    appointment_confirmed: ({ practice, startAt }) => ({
      subject: 'Appointment confirmed',
      body: `Confirmed: ${whenLabel('en', startAt, 'your appointment')}, ${practice}.`,
    }),
    form_request: ({ practice, link }) => ({
      subject: 'A form to complete before your visit',
      body: `${practice} has sent you a form to complete before your visit: ${link}. The link is personal to you — please do not forward it.`,
    }),
    portal_link: ({ practice, link }) => ({
      subject: 'Your upcoming appointments',
      body: `You can see your upcoming appointments with ${practice} here: ${link}. The link is personal to you — please do not forward it.`,
    }),
    appointment_cancelled: ({ practice }) => ({
      subject: 'Appointment cancelled',
      body: `Your appointment with ${practice} has been cancelled. Reply to this message to rebook.`,
    }),
    /**
     * The reply to a message this system could not place (P1-3).
     *
     * Every word of it is constrained twice over. It has to reach somebody who
     * might have written the most acute sentence of their life to a number the
     * front desk watches, so it must not leave them without a route to help —
     * and it goes to a lock screen somebody else might be holding, so it must
     * not say what kind of practice this is.
     *
     * Which is why 988 appears as a number and not by its name. The line is
     * called the Suicide & Crisis Lifeline, and both of those words are on the
     * deny-list — correctly, and this template is the proof the deny-list works:
     * the safest possible message would fail its own send if it named the
     * service it is pointing at. So it names the digits, which is what somebody
     * actually needs, and says nothing about why they might dial them.
     *
     * The other rule it breaks on purpose: this is the one client-facing body
     * allowed to carry a phone number for an outside service. Everything else
     * says when and where and links to the client's own door.
     */
    inbound_unparsed_reply: ({ practice, phone }) => ({
      subject: 'We got your message',
      body: `${practice} received your message, but this number is not monitored for replies. Please call us on ${phone} and we will pick it up from there. If you need urgent help right now, call or text 988, or call 911.`,
    }),
  },
  es: {
    appointment_reminder: ({ practice, startAt, link }) => ({
      subject: 'Recordatorio de cita',
      body: `Recordatorio de cita: ${whenLabel('es', startAt, 'su cita')}, ${practice}. Por favor indíquenos si va a venir: ${link}. El enlace es personal — por favor no lo reenvíe.`,
    }),
    appointment_confirmed: ({ practice, startAt }) => ({
      subject: 'Cita confirmada',
      body: `Confirmada: ${whenLabel('es', startAt, 'su cita')}, ${practice}.`,
    }),
    form_request: ({ practice, link }) => ({
      subject: 'Un formulario para completar antes de su visita',
      body: `${practice} le ha enviado un formulario para completar antes de su visita: ${link}. El enlace es personal — por favor no lo reenvíe.`,
    }),
    portal_link: ({ practice, link }) => ({
      subject: 'Sus próximas citas',
      body: `Puede ver sus próximas citas con ${practice} aquí: ${link}. El enlace es personal — por favor no lo reenvíe.`,
    }),
    appointment_cancelled: ({ practice }) => ({
      subject: 'Cita cancelada',
      body: `Su cita con ${practice} ha sido cancelada. Responda a este mensaje para reprogramarla.`,
    }),
    /**
     * The same two constraints, and the same escape from them: digits, never
     * the name of the service. 988 answers in Spanish, and saying so in words
     * would put "crisis" — spelled identically in both lists — on a lock
     * screen. `ayuda urgente` is the most this body will ever say about why.
     */
    inbound_unparsed_reply: ({ practice, phone }) => ({
      subject: 'Recibimos su mensaje',
      body: `${practice} recibió su mensaje, pero este número no se revisa para respuestas. Por favor llámenos al ${phone} y lo atenderemos desde ahí. Si necesita ayuda urgente ahora mismo, llame o envíe un mensaje de texto al 988, o llame al 911.`,
    }),
  },
};

async function messagingContext(db: Tx | typeof prisma): Promise<{ practice: string; phone: string }> {
  const s = await db.practiceSettings.findUnique({
    where: { id: 1 },
    select: { messagingName: true, practicePhone: true },
  });
  return { practice: s?.messagingName ?? 'Stillwater', phone: s?.practicePhone ?? '(555) 010-0199' };
}

interface QueueToClient {
  clientId: string;
  templateKey: TemplateKey;
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

  const { subject, body } = CLIENT_TEMPLATES[client.language][input.templateKey]({
    ...(await messagingContext(db)),
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
