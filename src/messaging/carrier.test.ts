import { describe, expect, it } from 'vitest';
import { HOUR } from '../clock';
import {
  abandonedAt,
  applyReceipt,
  DEFAULT_MIX,
  DEFAULT_RETRY,
  deliveryProven,
  nextAttemptAt,
  plausibleDestination,
  retryable,
  simulatedCarrier,
  type DeliveryEvent,
  type DeliveryFailure,
  type DeliveryRecord,
  type RetryPolicy,
  answerable,
} from './carrier';

const AT = new Date('2026-09-01T12:00:00Z');
const at = (ms: number) => new Date(AT.getTime() + ms);
/** A stable per-label offset, standing in for "a different moment". */
const hash = (label: string) => [...label].reduce((a, c) => a + c.charCodeAt(0), 0) * 60_000;

const record = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  state: 'sent',
  attempts: 1,
  failureCode: null,
  decidedAt: AT,
  ...over,
});

const event = (state: DeliveryEvent['state'], over: Partial<DeliveryEvent> = {}): DeliveryEvent => ({
  state,
  occurredAt: at(HOUR),
  ...over,
});

const failure = (code: DeliveryFailure, occurredAt = at(HOUR)): DeliveryEvent =>
  ({ state: 'failed', failureCode: code, occurredAt });

describe('retryable — one transient code, as a whitelist', () => {
  it('tries again only for the provider being down', () => {
    expect(retryable('carrier_unavailable')).toBe(true);
  });

  /**
   * Each of these ends the attempt for a different reason, and none of them
   * gets better by being sent again: the address is wrong, the address is dead,
   * the carrier refused it, or the client told the carrier to stop.
   */
  it('never retries a permanent one', () => {
    for (const code of ['invalid_destination', 'unreachable', 'rejected', 'opted_out_at_carrier', 'expired'] as const) {
      expect(retryable(code)).toBe(false);
    }
  });

  /**
   * The whitelist's whole purpose. A driver written next year against a
   * provider this codebase has never seen returns a code this codebase has
   * never seen, and the safe reading of an unknown failure is "stop" — because
   * a retry that eventually succeeds restores the fee's precondition, which
   * would let a provider bug end in a charge.
   */
  it('treats an unrecognised code as permanent', () => {
    expect(retryable('carrier_melted_down' as DeliveryFailure)).toBe(false);
  });
});

describe('nextAttemptAt — exponential, capped, and not random', () => {
  it('doubles each attempt', () => {
    expect(nextAttemptAt(1, AT)).toEqual(at(15 * 60_000));
    expect(nextAttemptAt(2, AT)).toEqual(at(30 * 60_000));
    expect(nextAttemptAt(3, AT)).toEqual(at(60 * 60_000));
  });

  it('stops doubling at the ceiling', () => {
    expect(nextAttemptAt(99, AT)).toEqual(at(DEFAULT_RETRY.maxDelayMs));
  });

  /** The injected clock exists so time-dependent behaviour is reproducible. */
  it('is deterministic, so the seeded quarter is hand-checkable', () => {
    expect(nextAttemptAt(2, AT)).toEqual(nextAttemptAt(2, AT));
  });
});

describe('applyReceipt — the only thing allowed to decide a message arrived', () => {
  it('records the carrier saying it arrived', () => {
    const next = applyReceipt(record(), event('delivered'));
    expect(next).toMatchObject({ state: 'delivered', failureCode: null, changed: true, nextAttemptAt: null });
    expect(next.decidedAt).toEqual(at(HOUR));
  });

  it('records acceptance as `sent`, which is not the same claim', () => {
    expect(applyReceipt(record({ state: 'queued', decidedAt: null }), event('sent')).state).toBe('sent');
  });

  /**
   * Rule 3. `failed` is the practice saying it is done trying, because that is
   * the only version of the word the work-list and the report can act on.
   */
  it('sends a transient failure back to the queue with a time on it', () => {
    const next = applyReceipt(record({ attempts: 1 }), failure('carrier_unavailable'));
    expect(next.state).toBe('queued');
    expect(next.failureCode).toBe('carrier_unavailable');
    expect(next.nextAttemptAt).toEqual(new Date(at(HOUR).getTime() + 15 * 60_000));
  });

  it('gives up on a transient failure once the attempts are spent', () => {
    const next = applyReceipt(record({ attempts: DEFAULT_RETRY.maxAttempts }), failure('carrier_unavailable'));
    expect(next).toMatchObject({ state: 'failed', failureCode: 'carrier_unavailable', nextAttemptAt: null });
  });

  it('fails a permanent code on the first receipt, whatever the attempts left', () => {
    const next = applyReceipt(record({ attempts: 1 }), failure('unreachable'));
    expect(next).toMatchObject({ state: 'failed', failureCode: 'unreachable', nextAttemptAt: null });
  });

  it('defaults a failure with no code to `rejected` rather than inventing a retry', () => {
    const next = applyReceipt(record(), { state: 'failed', occurredAt: at(HOUR) });
    expect(next).toMatchObject({ state: 'failed', failureCode: 'rejected' });
  });

  /**
   * Rule 1, and the reason this function takes timestamps at all. Provider
   * webhooks retry and duplicate; ordering by arrival would let a re-delivered
   * `sent` callback overwrite the `delivered` that followed it — and since the
   * fee reads this field, somebody else's retry policy would be deciding who
   * gets charged.
   */
  it('ignores a receipt older than the one that decided the current state', () => {
    const delivered = record({ state: 'delivered', decidedAt: at(HOUR) });
    const late = applyReceipt(delivered, failure('unreachable', at(30 * 60_000)));
    expect(late.changed).toBe(false);
    expect(late.state).toBe('delivered');
  });

  it('applies a newer receipt even when it contradicts a delivery', () => {
    const delivered = record({ state: 'delivered', decidedAt: at(HOUR) });
    const next = applyReceipt(delivered, failure('unreachable', at(2 * HOUR)));
    expect(next).toMatchObject({ state: 'failed', changed: true });
  });

  /**
   * Rule 2, the contradiction half. Two receipts stamped the same instant
   * saying opposite things are a carrier that does not know either way, so the
   * practice does not have proof of delivery — and the state that means "no
   * fee" is the honest one to land on.
   */
  it('lets failure win a tie in both directions', () => {
    const tied = record({ state: 'delivered', decidedAt: at(HOUR) });
    expect(applyReceipt(tied, failure('unreachable', at(HOUR))).state).toBe('failed');

    const failedFirst = record({ state: 'failed', failureCode: 'unreachable', decidedAt: at(HOUR) });
    expect(applyReceipt(failedFirst, event('delivered', { occurredAt: at(HOUR) })).changed).toBe(false);
  });

  /**
   * Rule 2, the progression half — and the case that made the rule wrong when
   * it was stated only as "a tie changes nothing". A provider that accepts and
   * delivers inside the same second is ordinary, and dropping its `delivered`
   * would throw away real proof of delivery for the sake of a tidier rule.
   * Which, since the fee reads this field, would exempt a client the practice
   * demonstrably reached.
   */
  it('takes a delivery stamped the same instant as the acceptance', () => {
    const accepted = record({ state: 'sent', decidedAt: at(HOUR) });
    expect(applyReceipt(accepted, event('delivered', { occurredAt: at(HOUR) }))).toMatchObject({
      state: 'delivered', changed: true,
    });
  });

  it('does not let a duplicate `sent` undo a delivery stamped the same instant', () => {
    const delivered = record({ state: 'delivered', decidedAt: at(HOUR) });
    expect(applyReceipt(delivered, event('sent', { occurredAt: at(HOUR) })).changed).toBe(false);
  });

  it('takes the first receipt when nothing has decided the row yet', () => {
    const fresh = record({ state: 'queued', attempts: 0, decidedAt: null });
    expect(applyReceipt(fresh, event('delivered', { occurredAt: at(-HOUR) })).state).toBe('delivered');
  });

  it('honours a caller-supplied retry policy', () => {
    const policy: RetryPolicy = { maxAttempts: 1, baseDelayMs: 1000, maxDelayMs: 1000 };
    expect(applyReceipt(record({ attempts: 1 }), failure('carrier_unavailable'), policy).state).toBe('failed');
  });
});

describe('deliveryProven — the money question, without a database', () => {
  it('is satisfied by one delivered message', () => {
    expect(deliveryProven(['failed', 'sent', 'delivered'])).toBe(true);
  });

  /**
   * The whole point of the phase. `sent` is the old precondition wearing a
   * better name: a carrier took the message, which says nothing about whether
   * anybody received it.
   */
  it('is not satisfied by queued, sent or failed, in any combination', () => {
    expect(deliveryProven(['queued', 'sent', 'failed'])).toBe(false);
    expect(deliveryProven(['sent'])).toBe(false);
    expect(deliveryProven([])).toBe(false);
  });

  /**
   * A real choice, not a default. Requiring all three would let a carrier
   * hiccup on the day-of nudge erase a `d5` message the client demonstrably
   * received — stricter, but not more honest.
   */
  it('does not require every stage to have arrived', () => {
    expect(deliveryProven(['delivered', 'failed', 'failed'])).toBe(true);
  });
});

describe('abandonedAt — a reminder about an hour that has started is worthless', () => {
  it('gives up once the appointment it is about has begun', () => {
    expect(abandonedAt(AT, at(HOUR), at(HOUR))).toBe(true);
    expect(abandonedAt(AT, at(HOUR), at(HOUR - 1))).toBe(false);
  });

  it('gives up on a message with no deadline after a week of trying', () => {
    expect(abandonedAt(AT, null, at(7 * 24 * HOUR))).toBe(true);
    expect(abandonedAt(AT, null, at(6 * 24 * HOUR))).toBe(false);
  });
});

describe('plausibleDestination — the address that is present and wrong', () => {
  it('accepts what could reach somebody', () => {
    expect(plausibleDestination('email', 'tc-001@example.test')).toBe(true);
    expect(plausibleDestination('sms', '(555) 010-0199')).toBe(true);
  });

  it('rejects blank, malformed and too-short', () => {
    expect(plausibleDestination('email', '   ')).toBe(false);
    expect(plausibleDestination('email', 'tc-001@example')).toBe(false);
    expect(plausibleDestination('email', 'not an address')).toBe(false);
    expect(plausibleDestination('sms', '555-0100')).toBe(false);
    expect(plausibleDestination('sms', '')).toBe(false);
  });
});

describe('simulatedCarrier — deterministic, offline, and honest about being a stub', () => {
  const carrier = simulatedCarrier();
  const message = (id: string, over: Partial<{ channel: 'email' | 'sms'; to: string }> = {}) => ({
    id, channel: 'email' as const, to: 'tc-001@example.test', body: 'Appointment reminder', ...over,
  });

  it('refuses an address that could not reach anybody, before any receipt', async () => {
    const ack = await carrier.send(message('m1', { to: 'nonsense' }));
    expect(ack).toMatchObject({ accepted: false, failureCode: 'invalid_destination' });
  });

  it('quotes a provider reference its receipts can be matched on', async () => {
    expect((await carrier.send(message('m2'))).providerRef).toBe('sim_m2');
  });

  /** The seeded quarter is a hand-checkable statement about *this* quarter. */
  it('fails the same messages every run', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `msg-${i}`);
    const once = ids.map((id) => carrier.settle({ to: `${id}@example.test`, scheduledFor: AT }, 1, AT).failureCode ?? 'delivered');
    const twice = ids.map((id) => carrier.settle({ to: `${id}@example.test`, scheduledFor: AT }, 1, AT).failureCode ?? 'delivered');
    expect(once).toEqual(twice);
  });

  /** Or the backoff path is dead code that the seed never walks. */
  it('lets a retry succeed where the first attempt hit an outage', () => {
    const to = 'reachable@example.test';
    const outage = Array.from({ length: 400 }, (_, i) => `m-${i}`)
      .find((id) => carrier.settle({ to, scheduledFor: at(hash(id)) }, 1, AT).failureCode === 'carrier_unavailable');
    expect(outage).toBeDefined();
    expect(carrier.settle({ to, scheduledFor: at(hash(outage!)) }, 2, AT).state).toBe('delivered');
  });

  /**
   * The modelling fix that made the seeded quarter mean anything. A permanent
   * failure is a property of the destination — a disconnected number is
   * disconnected for every message sent to it. Keying it on the message id
   * instead scattered single failures across many clients and produced a
   * quarter in which nobody was ever actually unreachable, which is exactly the
   * population the delivery precondition exists to protect.
   */
  it('keeps failing every message to a destination that does not work', () => {
    const dead = Array.from({ length: 400 }, (_, i) => `c${i}@example.test`)
      .find((to) => carrier.settle({ to, scheduledFor: AT }, 2, AT).failureCode === 'unreachable');
    expect(dead).toBeDefined();

    for (const id of ['d5', 'd1', 'd0', 'next-week']) {
      expect(carrier.settle({ to: dead!, scheduledFor: at(hash(id)) }, 2, AT).failureCode, id).toBe('unreachable');
    }
  });

  /** And a transient failure is a moment in time, so it does not follow anybody. */
  it('does not make an outage a property of the client', () => {
    const to = 'steady@example.test';
    const outages = Array.from({ length: 400 }, (_, i) => `x-${i}`)
      .filter((id) => carrier.settle({ to, scheduledFor: at(hash(id)) }, 1, AT).failureCode === 'carrier_unavailable');
    expect(outages.length).toBeGreaterThan(0);
    expect(outages.length).toBeLessThan(400);
  });

  it('produces a failure mix in the neighbourhood it advertises', () => {
    const addresses = Array.from({ length: 2000 }, (_, i) => `bulk-${i}@example.test`);
    const settled = addresses.map((to, i) => carrier.settle({ to, scheduledFor: AT }, 2, AT));
    const permanent = settled.filter((s) => s.failureCode === 'unreachable').length / addresses.length;
    expect(permanent).toBeGreaterThan(DEFAULT_MIX.permanent / 2);
    expect(permanent).toBeLessThan(DEFAULT_MIX.permanent * 2);
    // On the second attempt the transient band has cleared, by construction.
    expect(settled.some((s) => s.failureCode === 'carrier_unavailable')).toBe(false);
  });
});

describe('answerable — was there time to answer, not just time to ask', () => {
  const START = new Date('2026-09-01T19:00:00Z');
  const before = (ms: number) => new Date(START.getTime() - ms);

  it('accepts a message that arrived a comfortable margin ahead', () => {
    expect(answerable([before(5 * 24 * HOUR)], START, 120)).toBe(true);
    expect(answerable([before(3 * HOUR)], START, 120)).toBe(true);
  });

  it('is inclusive exactly at the window', () => {
    expect(answerable([before(2 * HOUR)], START, 120)).toBe(true);
    expect(answerable([before(2 * HOUR - 1)], START, 120)).toBe(false);
  });

  /** The case the seeded quarter found: delivered with an hour to spare. */
  it('refuses a message that arrived an hour before the session', () => {
    expect(answerable([before(HOUR)], START, 120)).toBe(false);
  });

  it('refuses one that arrived after the session started', () => {
    expect(answerable([new Date(START.getTime() + HOUR)], START, 120)).toBe(false);
  });

  /**
   * The earliest arrival is what counts. A client reached five days out had
   * five days, whatever became of the day-of nudge afterwards — the practice
   * does not lose proof it already had because a later message was late.
   */
  it('reads the earliest arrival, not the latest', () => {
    expect(answerable([before(5 * 24 * HOUR), before(30 * 60_000)], START, 120)).toBe(true);
    expect(answerable([before(30 * 60_000), before(5 * 24 * HOUR)], START, 120)).toBe(true);
  });

  it('ignores stages that never arrived', () => {
    expect(answerable([null, undefined], START, 120)).toBe(false);
    expect(answerable([null, before(3 * HOUR)], START, 120)).toBe(true);
    expect(answerable([], START, 120)).toBe(false);
  });

  /**
   * Zero turns the check off, and that is the setting reading exactly as it is
   * written rather than a special case: a practice that sets no window is a
   * practice charging on messages that arrived with minutes to spare.
   */
  it('is off at zero, and off means off', () => {
    expect(answerable([before(60_000)], START, 0)).toBe(true);
    expect(answerable([], START, 0)).toBe(true);
  });
});
