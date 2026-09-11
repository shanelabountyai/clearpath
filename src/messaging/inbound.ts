import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { NotFound } from '../errors';
import { alertRecipient } from '../staff/coverage';
import { localDateOf } from '../time';
import { fold, LANGUAGES, queueToClient, type Language } from './outbox';

/**
 * A client wrote back in words, and what the practice is allowed to keep.
 *
 * D-03 chose a tokenized link over a `YES`/`NO` keyword, and that choice
 * stands: a compulsory reply to an unknown short code is conspicuous on a lock
 * screen in a way a deny-list cannot fix. But a client who texts back anyway
 * should be understood rather than met with silence, so this is the other half
 * (D-04, Q1) — and its whole design is about how little it is permitted to
 * remember.
 *
 * The body is classified in memory and dropped. There is no column for it, no
 * log line, no audit reason, no alert field: a client can reply with anything
 * to a number front desk watches, including the most acute thing this practice
 * ever receives, and storing that would put clinical content on an operational
 * surface (hard rule 3) in front of the one role that must never see it (hard
 * rule 9). What lands in a row is one of three codes.
 *
 * The second design rule is what this file will NOT do. A caller ID is not a
 * credential. The portal link carries 24 random bytes and shows the fee before
 * it applies; a phone number is public and spoofable. So an inbound keyword may
 * record an answer, and it may never cancel a session or move money — the worst
 * a forged `NO` achieves here is a phone call the client was going to get
 * anyway.
 */

export type InboundClassification = 'confirm' | 'decline' | 'unparsed';

/**
 * Whole-message exact matches, after normalising, and nothing looser.
 *
 * Deliberately not "starts with yes" or "contains no". `no I cannot come, my
 * mother died last night` starts with a keyword and is not a keyword reply —
 * it is a person telling their practice something, and the only safe reading of
 * it is `unparsed`, which routes it to their clinician. A substring rule would
 * classify it, act on it, and drop the words on the floor with nobody told.
 *
 * So the cost of the strictness is a polite `yes thanks` reaching a clinician
 * who did not need it, and the cost of looseness is a disclosure nobody reads.
 * That is not a close call.
 */
export const PHRASES_BY_LANGUAGE: Record<Language, Record<string, InboundClassification>> = {
  en: {
    'y': 'confirm', 'yes': 'confirm', 'yes please': 'confirm', 'yep': 'confirm',
    'yeah': 'confirm', 'yup': 'confirm', 'ok': 'confirm', 'okay': 'confirm',
    'confirm': 'confirm', 'confirmed': 'confirm', 'coming': 'confirm',
    'ill be there': 'confirm', 'i will be there': 'confirm',

    'n': 'decline', 'no': 'decline', 'nope': 'decline', 'cancel': 'decline',
    'decline': 'decline', 'cant make it': 'decline', 'i cant make it': 'decline',
    'cannot make it': 'decline', 'wont be there': 'decline', 'not coming': 'decline',
  },
  // Written folded, like the deny-list: `sí` is stored as `si` because that is
  // what `normalise` produces, and an accented key would match nothing.
  es: {
    'si': 'confirm', 'si gracias': 'confirm', 'claro': 'confirm', 'vale': 'confirm',
    'ok': 'confirm', 'confirmo': 'confirm', 'confirmado': 'confirm',
    'alli estare': 'confirm', 'ahi estare': 'confirm', 'voy': 'confirm',

    'no': 'decline', 'cancelar': 'decline', 'cancela': 'decline',
    'no puedo': 'decline', 'no puedo ir': 'decline', 'no podre': 'decline',
    'no ire': 'decline', 'no voy': 'decline', 'no asistire': 'decline',
  },
};

/**
 * One table, every language, because an inbound message does not come with a
 * language on it.
 *
 * The client's stored `language` is a preference for what the practice writes,
 * not a promise about what they write back — a bilingual client answers in
 * whichever one their thumb reaches first — and the caller ID that would
 * "identify" them is not a credential in the first place (see below). So the
 * classifier reads the union and never guesses.
 *
 * The union is only safe while no phrase means opposite things in two
 * languages, which is a property of the data rather than of this code:
 * `inbound.test.ts` asserts it, and when it eventually fails the fix is to
 * delete the ambiguous phrase from both. An ambiguous keyword falls to
 * `unparsed`, which is a person ringing the client — the answer this whole
 * file defaults to whenever it is unsure.
 */
const PHRASES: Record<string, InboundClassification> = Object.assign(
  {},
  ...LANGUAGES.map((language) => PHRASES_BY_LANGUAGE[language]),
);

/**
 * Fold the accents into their letters, lowercase, drop apostrophes so `can't`
 * and `cant` are one phrase, and collapse everything else that is not a
 * letter. `YES!!` and `Yes.` and `yes ` are the same answer, an emoji is not
 * one, and `sí` is `si` rather than `s` — which is what stripping the accent
 * before folding it would have left.
 */
const normalise = (body: string): string =>
  fold(body).replace(/['‘’]/g, '').replace(/[^a-z]+/g, ' ').trim();

/** Pure, and the only function in the codebase that ever sees an inbound body. */
export function classifyInbound(body: string): InboundClassification {
  return PHRASES[normalise(body)] ?? 'unparsed';
}

export interface InboundResult {
  classification: InboundClassification;
  /** Null when no single client owns the address it arrived from. */
  clientId: string | null;
  /** The upcoming session the answer was taken to be about, if any. */
  appointmentId: string | null;
  /** Set when nothing was recorded, and why. */
  ignored?: 'unknown_sender' | 'ambiguous_sender';
}

const digits = (s: string): string => s.replace(/\D/g, '');

/**
 * Whose number this is — or nobody's, which is a real answer.
 *
 * Two clients sharing a phone is ordinary in this domain: a couple, a parent
 * and a teenager, a carer. It is also the case that must not guess. Confirming
 * the wrong person's hour is the mild version; an `unparsed` from a shared
 * phone would raise an alert about the wrong client to the wrong clinician,
 * which is a disclosure. So an address two clients answer to is treated as an
 * address nobody answers to, and front desk gets the call the old way.
 *
 * ponytail: scans every client with a phone and compares in JS, because there
 * is no normalised-number column to index. Fine at one practice; add a stored
 * `phoneDigits` column if this ever runs for a group.
 */
async function senderOf(from: string) {
  const select = { id: true, treatingClinicianId: true, phone: true } as const;

  if (from.includes('@')) {
    const matches = await prisma.client.findMany({
      where: { email: { equals: from.trim(), mode: 'insensitive' }, status: 'active' },
      select,
    });
    return matches.length === 1 ? matches[0]! : { ambiguous: matches.length > 1 };
  }

  const tail = digits(from).slice(-10);
  if (tail.length < 7) return { ambiguous: false };

  const withPhones = await prisma.client.findMany({
    where: { phone: { not: null }, status: 'active' },
    select,
  });
  const matches = withPhones.filter((c) => digits(c.phone ?? '').slice(-10) === tail);
  return matches.length === 1 ? matches[0]! : { ambiguous: matches.length > 1 };
}

/**
 * Take delivery of a reply. Simulated: nothing receives, the same way nothing
 * sends — `npm run inbound:simulate` is the stub, and it is deliberately not an
 * HTTP route. An unauthenticated public endpoint that can write to a client's
 * record needs a provider signature to verify, and a signature nobody issues is
 * a security control that only looks like one.
 */
export async function receiveInbound(
  input: { from: string; body: string },
  opts: { clock?: Clock } = {},
): Promise<InboundResult> {
  // First line of the function, on purpose: the body's whole life is this
  // expression, and nothing below it takes the words as an argument.
  const classification = classifyInbound(input.body);
  const clock = opts.clock ?? systemClock;
  const now = clock.now();

  const sender = await senderOf(input.from);
  if (!('id' in sender)) {
    return {
      classification,
      clientId: null,
      appointmentId: null,
      ignored: sender.ambiguous ? 'ambiguous_sender' : 'unknown_sender',
    };
  }

  const appointment = await prisma.appointment.findFirst({
    where: { clientId: sender.id, startAt: { gte: now }, status: { in: ['scheduled', 'confirmed'] } },
    orderBy: { startAt: 'asc' },
    select: { id: true },
  });

  /**
   * The client did this, and the trail says so — the same actor the portal door
   * uses, decided by the same matrix cell. What is weaker here is the
   * authentication, not the authorization, which is exactly why the branch
   * below writes an answer and never a cancellation.
   */
  const actor: Actor = { id: sender.id, role: 'client' };

  await guarded(
    {
      actor,
      action: 'update',
      resource: 'appointment',
      ...(appointment ? { resourceId: appointment.id } : {}),
      clientId: sender.id,
      target: { ownerClientId: sender.id },
      // A code, and the one thing about the message that is safe to keep.
      reason: `inbound:${classification}`,
    },
    async (tx) => {
      await tx.inboundReply.create({
        data: {
          clientId: sender.id,
          appointmentId: appointment?.id ?? null,
          classification,
          receivedAt: now,
        },
      });

      // An answer, never an attendance fact and never a cancellation. A
      // `decline` here leaves the hour standing and puts it on the front-desk
      // list with the client's number beside it: the fee disclosure the portal
      // shows before a late cancel cannot be shown in a text, and consent to a
      // charge cannot be inferred from two letters.
      if (appointment && classification !== 'unparsed') {
        await tx.appointment.update({
          where: { id: appointment.id },
          data: { confirmation: classification === 'confirm' ? 'confirmed' : 'declined' },
        });
      }

      if (classification === 'unparsed') {
        // Hard rule 9: one person, the treating clinician or their coverer,
        // never a shared surface. Reason codes only — the alert says a client
        // wrote, not what.
        await tx.alert.create({
          data: {
            ...(await alertRecipient(tx, sender.id, localDateOf(now))),
            clientId: sender.id,
            kind: 'inbound_unparsed',
            reasons: ['inbound:unparsed'],
          },
        });
        // Silence is the one reply this system must not give. Honours
        // `reminderPreference: 'none'` through `queueToClient`, which returns
        // null rather than sending — that client still reaches front desk's
        // list, and front desk still rings them.
        await queueToClient(
          { clientId: sender.id, templateKey: 'inbound_unparsed_reply', scheduledFor: now },
          tx,
        );
      }
    },
  );

  return { classification, clientId: sender.id, appointmentId: appointment?.id ?? null };
}

// ──────────────────────────── the front-desk side ────────────────────────────

/**
 * "This client replied — call them." The whole surface, and there is nothing
 * to read on it because there is nothing to read.
 */
export async function openInboundReplies(actor: Actor) {
  return guarded(
    { actor, action: 'read', resource: 'appointment' },
    (tx) =>
      tx.inboundReply.findMany({
        where: { classification: 'unparsed', handledAt: null },
        select: {
          id: true, receivedAt: true, clientId: true,
          client: { select: { code: true, firstName: true, lastName: true, phone: true } },
          appointment: { select: { id: true, startAt: true, clinician: { select: { name: true } } } },
        },
        orderBy: { receivedAt: 'asc' },
      }),
  );
}

/** Cleared once somebody has made the call. A list nobody can clear goes unread. */
export async function resolveInboundReply(
  actor: Actor,
  replyId: string,
  opts: { clock?: Clock } = {},
) {
  const reply = await prisma.inboundReply.findUnique({
    where: { id: replyId },
    select: { clientId: true },
  });
  if (!reply) throw new NotFound('InboundReply');

  return guarded(
    { actor, action: 'update', resource: 'appointment', resourceId: replyId, clientId: reply.clientId },
    (tx) =>
      tx.inboundReply.update({
        where: { id: replyId },
        data: { handledById: actor.id, handledAt: (opts.clock ?? systemClock).now() },
      }),
  );
}
