import { auditEvent, guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { NotFound } from '../errors';
import { ensurePortalLink, confirmAppointment, declineAppointment } from '../portal/service';
import { queueToClient } from './outbox';
import { LANGUAGES, normalise, type Language } from './language';

/**
 * A client texted back.
 *
 * The tap-link is the response this feature asked for, and a client who replies
 * in words anyway should be understood rather than met with silence — that is
 * the whole of P1-3. What it must not become is an inbound channel that
 * *stores* what they wrote.
 *
 * A person can reply to a reminder with anything. Some of them will reply with
 * the most acute thing they have ever written, to a number the front desk
 * monitors. Storing that body would put clinical content on an operational
 * surface (hard rule 3) and route it to the one desk that must never see it
 * (hard rule 9). So the message is classified in memory and dropped: `confirm`,
 * `decline`, `opt_out`, or `unparsed`. The `InboundReply` row has no column to
 * put a body in, which is the actual guarantee — the lint in the spec is only
 * the guard for the migration that adds one.
 *
 * What front desk learns from an `unparsed` reply is "this client replied, ring
 * them". Not one word of it.
 */

export type InboundClassification = 'confirm' | 'decline' | 'unparsed' | 'opt_out';

/**
 * Whole-message matches, deliberately.
 *
 * "Yes if my ride works out" is not a yes, and a system that decides it is will
 * confirm somebody's Tuesday on the strength of a word order. When the cost of
 * guessing wrong is a client's hour or a fee, the honest failure is `unparsed`
 * — which reaches a person, who can ask.
 */
const CONFIRM: Record<Language, readonly string[]> = {
  en: ['yes', 'y', 'yes please', 'confirm', 'confirmed', 'ok', 'okay', 'yep', 'yeah', 'sure', 'im coming'],
  es: ['si', 'si gracias', 'confirmo', 'confirmar', 'confirmado', 'vale', 'claro', 'de acuerdo', 'ahi estare'],
};
const DECLINE: Record<Language, readonly string[]> = {
  en: ['no', 'n', 'cancel', 'decline', 'declined', 'nope', 'cant make it'],
  es: ['no', 'no puedo', 'cancelar', 'cancelo', 'anular', 'no ire', 'no voy'],
};

/**
 * Carrier opt-out keywords. Not answers about an appointment, and not
 * translated either.
 *
 * They stay English in every language on purpose: `STOP` is what the carrier
 * recognises and what the regulator requires, regardless of what language the
 * client speaks or what the practice writes to them in. Translating them would
 * be inventing a second opt-out vocabulary that the network below this code
 * does not honour — a client texting `PARAR` to a US short code is opted out by
 * nobody. So the Spanish word is accepted here *as well*, because a client who
 * types it plainly means it and the practice can act even where the carrier
 * will not, and the English ones are honoured whoever sends them.
 */
const OPT_OUT: readonly string[] = [
  'stop', 'stopall', 'unsubscribe', 'cancelall', 'end', 'quit', 'revoke', 'optout', 'opt out',
  'parar', 'alto', 'baja', 'darme de baja', 'detener', 'cancelar suscripcion',
];

/**
 * Answers that mean the same thing in every language the practice ships.
 *
 * The digits are here rather than in each list because they are not words: a
 * client replying `1` is answering the numbered prompt, and the prompt is the
 * same shape in both languages.
 */
const UNIVERSAL_CONFIRM: readonly string[] = ['1', 'ok'];
const UNIVERSAL_DECLINE: readonly string[] = ['2'];

/**
 * What a token means, if the languages agree.
 *
 * A token that means one thing in the client's language and the opposite in
 * another is **not** resolved in the client's favour — it comes back
 * `unparsed`, which puts a person on the phone. It is the same rule as "yes if
 * my ride works out": when two readings are available and the cost of picking
 * the wrong one is somebody's hour or somebody's money, this system does not
 * pick. There is no such collision between English and Spanish today, and a
 * test says so — the rule exists for the third language, added by somebody who
 * will not think to check.
 */
function meaning(token: string, language: Language): InboundClassification {
  if (OPT_OUT.includes(token)) return 'opt_out';
  if (UNIVERSAL_CONFIRM.includes(token)) return 'confirm';
  if (UNIVERSAL_DECLINE.includes(token)) return 'decline';

  // The client's own language first, then the others — people code-switch, and
  // a Spanish-preferring client who types "yes" has still answered.
  const ordered: Language[] = [language, ...LANGUAGES.filter((l) => l !== language)];
  const readings = new Set(
    ordered
      .map((l): InboundClassification | null =>
        CONFIRM[l].includes(token) ? 'confirm' : DECLINE[l].includes(token) ? 'decline' : null)
      .filter((r): r is InboundClassification => r !== null),
  );

  if (readings.size !== 1) return 'unparsed';
  return [...readings][0]!;
}

/**
 * Classify, and keep nothing. Pure, so the whole table is assertable.
 *
 * `language` is the client's, and it decides which list is consulted first —
 * never which answer wins, because a token the languages disagree about has no
 * winner worth having.
 */
export function classifyReply(body: string, language: Language = 'en'): InboundClassification {
  // Accents and trailing punctuation are how people type; neither is a
  // different answer. "Sí", "si" and "SI." are one word to this function.
  const token = normalise(body).trim().replace(/[.!¡?¿,;\s]+$/g, '').replace(/\s+/g, ' ');
  return meaning(token, language);
}

/** Every token this classifier understands, for the collision test. */
export const KEYWORDS = { CONFIRM, DECLINE, OPT_OUT, UNIVERSAL_CONFIRM, UNIVERSAL_DECLINE };

interface InboundMessage {
  /** The address it arrived from — a phone number, or an email address. */
  from: string;
  /**
   * What the client wrote. Classified and discarded: it is never persisted,
   * never logged, and never passed to anything that persists or logs.
   */
  body: string;
}

/**
 * Take one inbound message.
 *
 * `from` is the authentication, and it is the same strength as the reminder
 * that prompted it — a message from the client's own number, exactly as a tap
 * comes from the link sent to it. A real carrier signs its webhook; the route
 * in front of this checks a shared secret, and the spoofing question is the
 * seam named there rather than here.
 */
export async function handleInboundReply(
  message: InboundMessage,
  opts: { clock?: Clock } = {},
) {
  const clock = opts.clock ?? systemClock;
  const now = clock.now();

  const client = await prisma.client.findFirst({
    where: { OR: [{ phone: message.from }, { email: message.from }] },
    select: { id: true, treatingClinicianId: true, phone: true, language: true },
  });
  // A number the practice does not know is not a client, and the reply is not
  // recorded against anybody. Nothing to answer and nothing to file.
  if (!client) throw new NotFound('Client');

  const classification = classifyReply(message.body, client.language);
  const channel = message.from === client.phone ? 'sms' : 'email';

  // The question this reply is answering: their soonest session that is still
  // waiting for one. A reply with no open question is filed and acted on by
  // nothing, which is honest — the practice can see they answered into silence.
  const open = classification === 'confirm' || classification === 'decline'
    ? await prisma.appointment.findFirst({
      where: { clientId: client.id, confirmation: 'pending', startAt: { gt: now } },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    })
    : null;

  const reply = await prisma.inboundReply.create({
    data: {
      clientId: client.id,
      appointmentId: open?.id ?? null,
      classification,
      channel,
      receivedAt: now,
      // Only an `unparsed` reply needs a person. The rest were understood, and
      // a work list full of resolved items is a work list nobody reads.
      handledAt: classification === 'unparsed' ? null : now,
    },
  });

  await auditEvent(
    { id: client.id, role: 'client' },
    'create', 'appointment',
    { resourceId: open?.id, clientId: client.id, rule: 'token', reason: `inbound:${classification}` },
  );

  if (open) {
    // Through the client's own door, so the confirm is idempotent and the
    // decline goes through `cancelAppointment` — `classifyCancellation` decides
    // late or advance from the clock, and this path adds no money logic at all.
    // A keyword reply and a tap reach the identical code.
    const link = await ensurePortalLink(client.id, clock);
    if (classification === 'confirm') {
      await confirmAppointment(link.token, open.id, { clock });
    } else {
      await declineAppointment(link.token, open.id, { clock, acknowledgeFee: true });
    }
  }

  if (classification === 'opt_out') {
    // Stop messaging them, and say nothing back. The cadence's own exemption
    // branch pulls their live `pending` rows to `not_required` on its next run,
    // so the safety setting reaches backwards without this having to know how.
    await prisma.client.update({
      where: { id: client.id },
      data: { reminderPreference: 'none' },
    });
  }

  if (classification === 'unparsed') {
    // Hard rule 9: the treating clinician, and nobody else. Reason codes only,
    // because there is nothing else — the words are already gone.
    await prisma.alert.create({
      data: {
        recipientId: client.treatingClinicianId,
        clientId: client.id,
        kind: 'inbound_unparsed',
        reasons: ['inbound:unparsed'],
      },
    });
    await queueToClient({
      clientId: client.id,
      templateKey: 'inbound_unparsed',
      scheduledFor: now,
    });
  }

  return reply;
}

/**
 * Replies still waiting for somebody to pick up a phone.
 *
 * Gated on the existing `appointment` resource, exactly as the reschedule-
 * request list is and for the same reason: this is scheduling work — a client
 * made contact and somebody has to ring them — and it carries a name, a number
 * and a timestamp. There is nothing clinical in it to justify a new matrix row,
 * because there is nothing in it at all beyond "they replied".
 */
export async function openInboundReplies(actor: Actor) {
  return guarded(
    { actor, action: 'read', resource: 'appointment' },
    (tx) =>
      tx.inboundReply.findMany({
        where: { handledAt: null },
        select: {
          id: true, receivedAt: true, channel: true, classification: true,
          client: {
            select: {
              id: true, code: true, firstName: true, lastName: true,
              // The number, because ringing them is the whole of the work.
              phone: true,
              treatingClinician: { select: { name: true } },
            },
          },
        },
        orderBy: { receivedAt: 'asc' },
      }),
  );
}

/** Somebody rang them. The list is a queue of calls, not a queue of messages. */
export async function markReplyHandled(actor: Actor, replyId: string, opts: { clock?: Clock } = {}) {
  const reply = await prisma.inboundReply.findUnique({
    where: { id: replyId }, select: { clientId: true },
  });
  if (!reply) throw new NotFound('InboundReply');

  return guarded(
    {
      actor, action: 'update', resource: 'appointment',
      resourceId: replyId, clientId: reply.clientId, reason: 'inbound:handled',
    },
    (tx) =>
      tx.inboundReply.update({
        where: { id: replyId },
        data: { handledAt: (opts.clock ?? systemClock).now(), handledById: actor.id },
      }),
  );
}
