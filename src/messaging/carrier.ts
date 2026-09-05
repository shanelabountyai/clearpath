import { HOUR } from '../clock';

/**
 * The carrier port, and the whole of what "delivered" is allowed to mean.
 *
 * Everything in this file is pure. That is not tidiness — it is the same
 * argument `confirmation.ts` makes about eligibility, applied to the other end
 * of the same policy. Until now the fee's precondition was an `OutboxMessage`
 * row, which proves the practice *intended* to ask. A row is not a delivery,
 * and the gap between the two is where a practice charges clients for its own
 * failed sends: a disconnected number, a mailbox that bounces, a carrier that
 * was down for the six hours the cadence happened to run in. Nobody notices,
 * because the evidence of the failure is exactly the same shape as the
 * evidence of a client ignoring you — silence.
 *
 * So delivery becomes a fact with its own vocabulary, its own state machine and
 * its own receipts, and `no_response` stops being reachable without one.
 *
 * Still nothing sends. `simulatedCarrier` is a driver like any other and it is
 * the only one this repository ships, because a real credential here would mean
 * real messages to real handsets from a project whose first promise is that it
 * holds nothing real. What changed is that the seam is now honest: a deployment
 * writes a second driver against `Carrier` and changes no policy code at all.
 */

/**
 * Where a message is, from the practice's side of the wire.
 *
 * Four states, and the two that look similar are the important pair. `sent`
 * means a carrier accepted it — the old, weaker claim, now named as the weak
 * claim it always was. `delivered` means a carrier came back and said it
 * arrived. Only the second one is allowed near money.
 */
export type DeliveryState = 'queued' | 'sent' | 'delivered' | 'failed';

/**
 * Why a message did not arrive. Codes, never provider prose.
 *
 * A carrier's error string is free text written by somebody else's system, and
 * it routinely echoes the message and the destination back at you. Storing it
 * would put a body and a phone number in an operational table by accident,
 * which is hard rule 3 broken by a field nobody thought about. So the driver
 * maps to this closed set at the boundary and the string is dropped there.
 */
export type DeliveryFailure =
  /** Not an address at all: blank, malformed, too few digits. */
  | 'invalid_destination'
  /** A real address that no longer reaches anybody. Disconnected, bounced. */
  | 'unreachable'
  /** The carrier refused to carry it. Filtered, blocked sender, bad sender id. */
  | 'rejected'
  /** The client stopped us at the carrier, not at us. Terminal, and never retried. */
  | 'opted_out_at_carrier'
  /** The provider, not the client. The only code worth trying again. */
  | 'carrier_unavailable'
  /** We ran out of time: the appointment arrived before the message did. */
  | 'expired';

/**
 * The one transient code.
 *
 * Deliberately a whitelist rather than a blacklist. An unknown code from a new
 * driver is treated as permanent, which costs one undelivered message; treating
 * it as transient would cost an unbounded retry loop against somebody else's
 * rate limiter, and — because a retry that eventually "succeeds" would restore
 * the fee's precondition — could turn a provider bug into a charge.
 */
const TRANSIENT: readonly DeliveryFailure[] = ['carrier_unavailable'];

/** Whether this failure is worth another attempt at all. */
export function retryable(code: DeliveryFailure): boolean {
  return TRANSIENT.includes(code);
}

export interface RetryPolicy {
  /** Attempts in total, not retries after the first. */
  maxAttempts: number;
  /** First backoff step; each attempt doubles it. */
  baseDelayMs: number;
  /** The ceiling, because a reminder five days out has five days of patience and no more. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 15 * 60_000,
  maxDelayMs: 4 * HOUR,
};

/**
 * When attempt number `attempts` may be tried again.
 *
 * Exponential, capped, and deliberately not jittered: this codebase's clock is
 * injected precisely so that time-dependent behaviour is reproducible, and a
 * random component would make the seeded quarter unhand-checkable for the sake
 * of a thundering herd this project cannot have.
 */
export function nextAttemptAt(attempts: number, from: Date, policy: RetryPolicy = DEFAULT_RETRY): Date {
  const step = Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempts - 1), policy.maxDelayMs);
  return new Date(from.getTime() + step);
}

/** What a carrier says about one message, once. */
export interface DeliveryEvent {
  state: 'sent' | 'delivered' | 'failed';
  failureCode?: DeliveryFailure;
  /** The carrier's timestamp for the event, not ours for receiving it. */
  occurredAt: Date;
}

/** The delivery half of an outbox row — everything `applyReceipt` may read. */
export interface DeliveryRecord {
  state: DeliveryState;
  attempts: number;
  failureCode: DeliveryFailure | null;
  /** When the carrier event that put it in this state happened. */
  decidedAt: Date | null;
}

export interface DeliveryTransition {
  state: DeliveryState;
  failureCode: DeliveryFailure | null;
  decidedAt: Date;
  /** Set only where the state went back to `queued` for another attempt. */
  nextAttemptAt: Date | null;
  /** False where the receipt was ignored, so the caller writes nothing. */
  changed: boolean;
}

/**
 * The delivery state machine. One pure function, and the only thing allowed to
 * decide that a message arrived.
 *
 * Three rules, each of which exists because of a way carriers actually behave:
 *
 *   1. **Receipts are ordered by the carrier's clock, not by ours.** Webhooks
 *      arrive out of order, retry, and duplicate. Ordering by arrival would let
 *      a re-delivered `sent` callback overwrite the `delivered` that followed
 *      it, and — since the fee reads this field — a provider's retry policy
 *      would silently decide who gets charged.
 *   2. **On a tie, failure wins — but only against a contradiction.** Two
 *      receipts stamped the same second saying opposite things are a carrier
 *      that does not know either, so the practice does not have proof of
 *      delivery and the state meaning "no fee" is the honest one. Two stamped
 *      the same second that *agree* are a progression, not a contradiction: a
 *      provider that accepts and delivers inside one second is ordinary, and
 *      dropping its `delivered` would throw away real proof for a tidier rule.
 *   3. **A transient failure with attempts left is not `failed`.** It goes back
 *      to `queued` with a time on it. `failed` here means the practice is done
 *      trying, which is the only version of the word the work-list and the
 *      report can act on.
 *
 * `delivered` is not hardcoded as terminal. It does not need to be: rule 1
 * makes a later contradiction win only if the carrier itself says it happened
 * later, and if a carrier genuinely retracts a delivery then the practice's
 * proof is gone and the fee should go with it.
 */
/**
 * How far along a state is, for resolving a tie between two receipts that do
 * not contradict each other. `failed` is not on this scale by accident: it is
 * never compared here, because a failure wins a tie outright.
 */
const RANK: Record<DeliveryState, number> = { failed: 0, queued: 1, sent: 2, delivered: 3 };

export function applyReceipt(
  record: DeliveryRecord,
  event: DeliveryEvent,
  policy: RetryPolicy = DEFAULT_RETRY,
): DeliveryTransition {
  const unchanged: DeliveryTransition = {
    state: record.state,
    failureCode: record.failureCode,
    decidedAt: record.decidedAt ?? event.occurredAt,
    nextAttemptAt: null,
    changed: false,
  };

  // Rule 1: an event older than the one that decided the current state is stale.
  if (record.decidedAt && event.occurredAt < record.decidedAt) return unchanged;

  // Rule 2, on an exact tie. A failure always lands. Anything else has to be
  // an advance on where the row already is, which keeps `sent` → `delivered`
  // inside one second while refusing both a `delivered` that would overwrite a
  // simultaneous failure and a duplicate `sent` that would undo a delivery.
  if (record.decidedAt && event.occurredAt.getTime() === record.decidedAt.getTime() && event.state !== 'failed') {
    if (record.state === 'failed' || RANK[event.state] <= RANK[record.state]) return unchanged;
  }

  if (event.state !== 'failed') {
    return {
      state: event.state,
      failureCode: null,
      decidedAt: event.occurredAt,
      nextAttemptAt: null,
      changed: true,
    };
  }

  const code = event.failureCode ?? 'rejected';
  // Rule 3. `attempts` is what has already been spent, so the comparison is
  // "is there another one left", not "have we used them all".
  const tryAgain = retryable(code) && record.attempts < policy.maxAttempts;

  return {
    state: tryAgain ? 'queued' : 'failed',
    failureCode: code,
    decidedAt: event.occurredAt,
    nextAttemptAt: tryAgain ? nextAttemptAt(record.attempts, event.occurredAt, policy) : null,
    changed: true,
  };
}

/**
 * The money question, as a pure function: did the practice actually reach this
 * client about this appointment?
 *
 * One delivered message is enough, and that is a real choice rather than a
 * default. Requiring all three would mean a carrier hiccup on the day-of nudge
 * erases a `d5` message the client demonstrably received, which is not more
 * honest, only stricter. Requiring none is where this feature started and is
 * what this phase exists to end. `sent` counts for nothing here, deliberately:
 * that is the old precondition wearing a better name.
 */
export function deliveryProven(states: readonly DeliveryState[]): boolean {
  return states.includes('delivered');
}

/**
 * P2-3. Did the client have a real chance to answer before the hour arrived?
 *
 * The second half of a question this system had only ever asked one half of.
 * `graceMinutes` checks there was time to **ask** — measured at booking, before
 * anything is sent. Nothing checked there was time to **answer**, and for five
 * phases nothing needed to: a full cadence puts the first message five days
 * out, so the answer to this was always obviously yes.
 *
 * A per-client cadence made it not obviously yes. A client on the day-of nudge
 * alone is asked once, a few hours before, and if the send or the carrier eats
 * most of that they are charged for not answering a message that arrived with
 * minutes to spare. That is the same untruth the delivery precondition was
 * built to stop, one step further along: the practice reached them, but not in
 * time for reaching them to mean anything.
 *
 * The seeded quarter is what turned this from a worry into a number. It caught
 * the fee rate crossing the PRD's own 5% over-firing line, and the cause was a
 * cohort whose median gap between "delivered" and "start" was **one hour**.
 *
 * The earliest delivery is what counts, not the latest: a client reached five
 * days out had five days, whatever happened to the day-of nudge afterwards.
 */
export function answerable(
  deliveredAt: readonly (Date | null | undefined)[],
  startAt: Date,
  windowMinutes: number,
): boolean {
  if (windowMinutes <= 0) return true;
  const cutoff = startAt.getTime() - windowMinutes * 60_000;
  return deliveredAt.some((at) => !!at && at.getTime() <= cutoff);
}

/**
 * A message the practice should stop trying to send.
 *
 * A reminder is a message about an hour, and it is worthless once the hour has
 * started — worse than worthless, because a client who gets "are you coming
 * Tuesday" on Wednesday learns that this practice's messages are not worth
 * reading. So a still-unsettled message past its own appointment is abandoned
 * as `expired` rather than retried into irrelevance.
 */
export function abandonedAt(scheduledFor: Date, deadline: Date | null, now: Date): boolean {
  if (deadline && now >= deadline) return true;
  return now.getTime() - scheduledFor.getTime() >= 7 * 24 * HOUR;
}

// ─────────────────────────── the port ───────────────────────────

/** What a driver is handed. Ids and the text to carry, and nothing else. */
export interface CarrierMessage {
  id: string;
  channel: 'email' | 'sms';
  to: string;
  subject?: string | null;
  body: string;
}

/** A driver's answer to "did you take it". Not "did it arrive" — see `DeliveryEvent`. */
export interface CarrierAck {
  /** The provider's handle for this attempt, which its receipts will quote back. */
  providerRef: string;
  accepted: boolean;
  failureCode?: DeliveryFailure;
}

/**
 * The seam a real deployment implements.
 *
 * Two methods, because that is the shape of every messaging provider worth
 * using: a synchronous accept-or-reject, and receipts that arrive later by
 * webhook. A driver that only had `send` would be a driver that could not tell
 * you anything this phase is about.
 */
export interface Carrier {
  readonly name: string;
  send(message: CarrierMessage): Promise<CarrierAck>;
}

/**
 * A carrier that additionally knows, in advance, what it is going to say.
 *
 * Only a simulation can offer this, and the seed needs it: a webhook that
 * arrives from nowhere cannot drive a hand-checkable quarter. Kept off
 * `Carrier` so that no policy code can accidentally depend on being able to ask
 * the future.
 */
export interface SimulatedCarrier extends Carrier {
  settle(message: { to: string; scheduledFor: Date }, attempt: number, occurredAt: Date): DeliveryEvent;
}

export interface SimulationMix {
  /** Share of messages whose first attempt hits a provider outage and then succeeds. */
  transient: number;
  /** Share that permanently do not arrive at a well-formed address. */
  permanent: number;
  /** Share the carrier holds because the client opted out on its side. */
  optedOut: number;
  /** Minutes between acceptance and the receipt that settles it. */
  receiptLagMinutes: number;
}

export const DEFAULT_MIX: SimulationMix = {
  transient: 0.04,
  permanent: 0.02,
  optedOut: 0.005,
  receiptLagMinutes: 12,
};

/**
 * FNV-1a, so that "which messages fail" is a stable property of the data rather
 * than of when the seed ran. A random mix would make every seeded quarter a
 * different quarter, and the metrics in `prisma/metrics.ts` are hand-checkable
 * statements about *this* one.
 *
 * Note what is deliberately **not** hashed: the message id. It is a cuid, so it
 * is different on every seed run — keying anything on it makes the quarter
 * drift between runs, which is how a fixed set of hand-tallied metrics quietly
 * becomes a flaky test. Everything here hashes the destination and the moment,
 * both of which the simulation itself decides.
 */
function bucket(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

/**
 * Whether an address could possibly reach anybody.
 *
 * Checked here rather than at queue time on purpose: this is the carrier's
 * judgement, and a driver for a different provider will draw the line
 * differently. `confirmationRequired` already refuses to ask a client with no
 * address at all; this catches the one that is present and wrong, which is the
 * case that used to end in a fee.
 */
export function plausibleDestination(channel: 'email' | 'sms', to: string): boolean {
  const value = to.trim();
  if (!value) return false;
  if (channel === 'email') return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
  return value.replace(/\D/g, '').length >= 10;
}

/**
 * The only driver this repository ships. Deterministic, offline, and honest
 * about being a stub — it returns verdicts, never touches a network, and never
 * writes the body anywhere.
 */
export function simulatedCarrier(mix: SimulationMix = DEFAULT_MIX): SimulatedCarrier {
  return {
    name: 'simulated',

    async send(message) {
      const ref = `sim_${message.id}`;
      if (!plausibleDestination(message.channel, message.to)) {
        return { providerRef: ref, accepted: false, failureCode: 'invalid_destination' };
      }
      // Keyed on the destination, like every other verdict here and for both
      // reasons: an opt-out held at the carrier belongs to the person, not to
      // one message, and the message id is a cuid that would make the seeded
      // quarter drift between runs.
      if (bucket(`${message.to}:accept`) < mix.optedOut) {
        return { providerRef: ref, accepted: false, failureCode: 'opted_out_at_carrier' };
      }
      return { providerRef: ref, accepted: true };
    },

    settle(message, attempt, occurredAt) {
      // Two different things fail, and they are seeded on two different keys
      // because they are properties of two different objects.
      //
      // A permanent failure belongs to the **destination**: a disconnected
      // number is disconnected for every message sent to it, not for one in
      // fifty. Keying it on the message id — the obvious first cut, and wrong —
      // scatters single failures across many clients and produces a quarter in
      // which nobody is ever actually unreachable. That is the population the
      // whole delivery precondition exists to protect, so a simulation that
      // cannot produce it cannot demonstrate the rule works.
      if (bucket(`${message.to}:reachable`) < mix.permanent) {
        return { state: 'failed', failureCode: 'unreachable', occurredAt };
      }

      // A transient failure belongs to the **moment**: it is the provider having
      // a bad minute, and the same client sends fine an hour later. Keyed on
      // destination-and-instant rather than on the message id, which is a cuid
      // and would make the quarter different every run. Two messages to one
      // client queued in the same instant therefore share a fate, which is what
      // one provider outage actually looks like.
      //
      // It clears on the second attempt, which is the whole point of having one
      // — the retry has to be able to succeed or the backoff is never exercised.
      if (bucket(`${message.to}:${message.scheduledFor.getTime()}`) < mix.transient && attempt <= 1) {
        return { state: 'failed', failureCode: 'carrier_unavailable', occurredAt };
      }

      return { state: 'delivered', occurredAt };
    },
  };
}
