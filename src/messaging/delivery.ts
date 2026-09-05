import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import {
  abandonedAt,
  applyReceipt,
  DEFAULT_MIX,
  DEFAULT_RETRY,
  simulatedCarrier,
  type Carrier,
  type DeliveryEvent,
  type DeliveryFailure,
  type DeliveryState,
  type RetryPolicy,
  type SimulatedCarrier,
} from './carrier';

/**
 * The two jobs that put a carrier behind the outbox.
 *
 * `carrier.ts` decides what a delivery *is*; this file is the only thing that
 * writes a row because of one. Same split as `confirmation.ts` / `reminders.ts`
 * and for the same reason: the rule that decides whether a client can be
 * charged has to be assertable without a database.
 *
 * Two entry points, because a provider has two halves. `dispatchOutbox` hands
 * queued messages over and records what came back synchronously.
 * `recordReceipt` is what the provider's webhook calls minutes later, and is
 * the only path to `delivered`.
 *
 * **Nothing here is audit-logged per receipt, deliberately.** The audit trail
 * records what the *practice* did — it already carries `reminder_queued` for
 * the send and, from this phase on, `confirmation_undelivered` for a fee the
 * delivery record suppressed. A row per carrier callback would bury both under
 * somebody else's retry policy. The `DeliveryReceipt` rows are themselves the
 * trail for this, and they are the reason ignored receipts are kept.
 */

/** Ten minutes of work per run, so a stuck provider cannot hold the job open. */
const DISPATCH_BATCH = 500;

export interface DispatchResult {
  /** Handed to the carrier and accepted. */
  sent: string[];
  /** Refused at the door — a bad address, or an opt-out held on the carrier's side. */
  rejected: string[];
  /** Back in the queue with a time on them. */
  retrying: string[];
  /** Abandoned: the hour they were about has started. */
  expired: string[];
}

interface Addressable {
  channel: 'email' | 'sms';
  userId: string | null;
  client: { email: string | null; phone: string | null } | null;
}

/**
 * Where a batch of messages is actually going.
 *
 * Resolved here, at the wire, rather than stored on the row when it was
 * queued. A client who corrects their number on Tuesday should have Wednesday's
 * reminder go to the new one, and a copy of the destination sitting in the
 * outbox would be a second place a phone number lives — and the place nobody
 * remembers to update when a client asks to be forgotten.
 *
 * Clinician-directed rows carry a bare `userId` rather than a relation, so they
 * are resolved in one query for the batch instead of one per message.
 */
async function destinations(messages: readonly Addressable[]): Promise<(m: Addressable) => string> {
  const userIds = [...new Set(messages.map((m) => m.userId).filter((id): id is string => !!id))];
  const staff = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const byId = new Map(staff.map((u) => [u.id, u.email]));

  return (message) => {
    if (message.userId) return byId.get(message.userId) ?? '';
    if (!message.client) return '';
    return (message.channel === 'email' ? message.client.email : message.client.phone) ?? '';
  };
}

/**
 * Hand every due message to the carrier.
 *
 * Idempotent in the same shape as the cadence: the state moves off `queued` in
 * the same statement that spends the attempt, so a second run finds nothing to
 * do. Running it twice, hourly, or after a missed day costs lateness and
 * nothing else.
 */
export async function dispatchOutbox(
  opts: { clock?: Clock; carrier?: Carrier; policy?: RetryPolicy; limit?: number } = {},
): Promise<DispatchResult> {
  const clock = opts.clock ?? systemClock;
  const carrier = opts.carrier ?? simulatedCarrier();
  const policy = opts.policy ?? DEFAULT_RETRY;
  const now = clock.now();

  const due = await prisma.outboxMessage.findMany({
    where: {
      deliveryState: 'queued',
      scheduledFor: { lte: now },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: {
      id: true, channel: true, subject: true, body: true, attempts: true,
      scheduledFor: true, expiresAt: true, decidedAt: true, failureCode: true,
      userId: true,
      client: { select: { email: true, phone: true } },
    },
    orderBy: { scheduledFor: 'asc' },
    take: opts.limit ?? DISPATCH_BATCH,
  });

  const addressOf = await destinations(due);
  const result: DispatchResult = { sent: [], rejected: [], retrying: [], expired: [] };

  for (const message of due) {
    // Ours, not the carrier's — so it gets no receipt row. A receipt is
    // something a provider said, and nobody said this: the practice ran out of
    // time and stopped. Keeping the distinction means a defence of the fee can
    // separate "they did not get it" from "we gave up".
    if (abandonedAt(message.scheduledFor, message.expiresAt, now)) {
      await prisma.outboxMessage.update({
        where: { id: message.id },
        data: { deliveryState: 'failed', failureCode: 'expired', decidedAt: now, nextAttemptAt: null },
      });
      result.expired.push(message.id);
      continue;
    }

    const attempt = message.attempts + 1;
    const ack = await carrier.send({
      id: message.id,
      channel: message.channel,
      to: addressOf(message),
      subject: message.subject,
      body: message.body,
    });

    const event: DeliveryEvent = ack.accepted
      ? { state: 'sent', occurredAt: now }
      : { state: 'failed', failureCode: ack.failureCode ?? 'rejected', occurredAt: now };

    // The ack goes through the same state machine as a webhook, because it is
    // the same kind of statement: a carrier's word about one attempt. That is
    // what gives a rejection at the door the retry semantics a rejection in a
    // callback already had, without a second copy of the rule.
    const next = applyReceipt(
      { state: 'queued', attempts: attempt, failureCode: message.failureCode, decidedAt: null },
      event,
      policy,
    );

    await prisma.$transaction([
      prisma.outboxMessage.update({
        where: { id: message.id },
        data: {
          deliveryState: next.state,
          failureCode: next.failureCode,
          decidedAt: next.decidedAt,
          nextAttemptAt: next.nextAttemptAt,
          attempts: attempt,
          providerRef: ack.providerRef,
          carrier: carrier.name,
          sentAt: ack.accepted ? now : null,
        },
      }),
      prisma.deliveryReceipt.create({
        data: {
          outboxMessageId: message.id,
          providerRef: ack.providerRef,
          state: event.state,
          failureCode: event.failureCode ?? null,
          attempt,
          occurredAt: now,
          ignored: false,
        },
      }),
    ]);

    if (next.state === 'sent') result.sent.push(message.id);
    else if (next.state === 'queued') result.retrying.push(message.id);
    else result.rejected.push(message.id);
  }

  return result;
}

export interface ReceiptInput {
  providerRef: string;
  state: DeliveryState;
  failureCode?: DeliveryFailure | null;
  occurredAt: Date;
}

export interface ReceiptResult {
  outboxMessageId: string;
  state: DeliveryState;
  /** False where the state machine ignored it as stale or as a losing tie. */
  applied: boolean;
}

/**
 * A carrier's callback. The only path to `delivered`, and therefore the only
 * path to a non-response fee.
 *
 * Matching is on the provider's reference rather than on our id, because that
 * is all a provider quotes back. A reference from a superseded attempt still
 * resolves — its receipt row is still here — so a callback for attempt one
 * arriving after attempt two has begun lands on the right message and is then
 * judged on its timestamp like any other.
 *
 * An unknown reference returns null rather than throwing. Carriers replay old
 * callbacks after an outage, and a 500 at the webhook would make the provider
 * retry a message this practice no longer has.
 */
export async function recordReceipt(
  input: ReceiptInput,
  opts: { clock?: Clock; policy?: RetryPolicy } = {},
): Promise<ReceiptResult | null> {
  const clock = opts.clock ?? systemClock;
  const policy = opts.policy ?? DEFAULT_RETRY;

  const message =
    (await prisma.outboxMessage.findUnique({
      where: { providerRef: input.providerRef },
      select: { id: true, deliveryState: true, attempts: true, failureCode: true, decidedAt: true },
    }))
    ?? (await prisma.outboxMessage.findFirst({
      where: { receipts: { some: { providerRef: input.providerRef } } },
      select: { id: true, deliveryState: true, attempts: true, failureCode: true, decidedAt: true },
    }));

  if (!message) return null;

  const event: DeliveryEvent = {
    state: input.state === 'queued' ? 'sent' : input.state,
    failureCode: input.failureCode ?? undefined,
    occurredAt: input.occurredAt,
  };

  const next = applyReceipt(
    {
      state: message.deliveryState,
      attempts: message.attempts,
      failureCode: message.failureCode,
      decidedAt: message.decidedAt,
    },
    event,
    policy,
  );

  await prisma.$transaction([
    prisma.deliveryReceipt.create({
      data: {
        outboxMessageId: message.id,
        providerRef: input.providerRef,
        state: event.state,
        failureCode: event.failureCode ?? null,
        attempt: message.attempts,
        occurredAt: input.occurredAt,
        // Kept even though it changed nothing. A trail that only records the
        // receipts that won is not a trail, and "the carrier contradicted
        // itself" is exactly the thing somebody defending a fee needs to see.
        ignored: !next.changed,
      },
    }),
    ...(next.changed
      ? [prisma.outboxMessage.update({
          where: { id: message.id },
          data: {
            deliveryState: next.state,
            failureCode: next.failureCode,
            decidedAt: next.decidedAt,
            nextAttemptAt: next.nextAttemptAt,
            deliveredAt: next.state === 'delivered' ? input.occurredAt : null,
          },
        })]
      : []),
  ]);

  // `clock` is taken and unused on the applied path on purpose: it is what
  // `receivedAt` would use if this ever needed to record our own arrival time
  // separately from the database default. Named rather than dropped so the
  // signature does not change the day it does.
  void clock;

  return { outboxMessageId: message.id, state: next.state, applied: next.changed };
}

/**
 * The webhook that never arrives, for the practice that has no carrier.
 *
 * A seeded quarter needs receipts, and receipts come from outside. So the
 * simulated driver is asked what it is going to say, and this settles every
 * message whose acceptance is older than the provider's advertised lag. It
 * exists for the seed and the e2e sweep and is not reachable from the
 * application: a real deployment deletes the call, not the module.
 */
export async function settleSimulated(
  opts: { clock?: Clock; carrier?: SimulatedCarrier; lagMinutes?: number; limit?: number } = {},
): Promise<ReceiptResult[]> {
  const clock = opts.clock ?? systemClock;
  const carrier = opts.carrier ?? simulatedCarrier();
  const lag = (opts.lagMinutes ?? DEFAULT_MIX.receiptLagMinutes) * 60_000;
  const now = clock.now();

  const awaiting = await prisma.outboxMessage.findMany({
    where: { deliveryState: 'sent', sentAt: { lte: new Date(now.getTime() - lag) } },
    select: {
      id: true, providerRef: true, attempts: true, channel: true, userId: true,
      scheduledFor: true,
      client: { select: { email: true, phone: true } },
    },
    orderBy: { sentAt: 'asc' },
    take: opts.limit ?? DISPATCH_BATCH,
  });

  const addressOf = await destinations(awaiting);
  const settled: ReceiptResult[] = [];
  for (const message of awaiting) {
    const event = carrier.settle(
      { to: addressOf(message), scheduledFor: message.scheduledFor },
      message.attempts,
      now,
    );
    const result = await recordReceipt({
      providerRef: message.providerRef ?? `sim_${message.id}`,
      state: event.state,
      failureCode: event.failureCode,
      occurredAt: event.occurredAt,
    }, { clock });
    if (result) settled.push(result);
  }
  return settled;
}

/**
 * One run of both halves, which is what a cron actually wants.
 *
 * The order matters and is the realistic one: settle what the carrier has
 * already answered, then hand over what is due — so a transient failure
 * settled this minute is retried on its own backoff rather than in the same
 * pass that recorded it.
 */
export async function runCarrier(
  opts: { clock?: Clock; carrier?: SimulatedCarrier; lagMinutes?: number } = {},
) {
  const settled = await settleSimulated(opts);
  const dispatched = await dispatchOutbox({ clock: opts.clock, carrier: opts.carrier });
  return { settled, dispatched };
}
