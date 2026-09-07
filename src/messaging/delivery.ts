import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { NotFound } from '../errors';

/**
 * What happened to a message after it left, and the reason the fee now depends
 * on it.
 *
 * Until this file existed, the precondition for charging a client for silence
 * was an `OutboxMessage` row — which proves the practice *intended* to ask, and
 * nothing more. A queued message is an intention. It is not evidence that a
 * phone ever buzzed. Charging on it means the practice bills clients for its
 * own failed sends, and the client cannot tell the difference between "I
 * ignored it" and "it never came", because there is nothing to point at.
 *
 * So the outbox grows a lifecycle — `queued` → `sent` → `delivered` | `failed`
 * — and `nonresponse.ts` reads the terminal state rather than the row's
 * existence. Nothing about the evidence changes: silence is still recorded
 * whatever happened to the message, because whether the client answered and
 * whether the practice reached them are two different facts, the same way
 * `confirmation` and `status` are (D-02). Only the money moves.
 *
 * Nothing here talks to a carrier either. `dispatchOutbox` is the seam a real
 * one plugs into, and `recordDeliveryReceipt` is the shape of the webhook it
 * would call back on — which is why the receipt takes an outcome and a reason
 * CODE and has no opinion of its own about whether a message arrived.
 */

export type DeliveryOutcome = 'delivered' | 'failed';

/**
 * Hand every due message to the carrier. Today that is a state change and a
 * timestamp, which is exactly what a send is from this side of the wire.
 *
 * Only `queued` rows move, so running it twice is running it once — the same
 * property the horizon has, and for the same reason: a scheduler that fires
 * twice must not be able to send twice.
 */
export async function dispatchOutbox(clock: Clock = systemClock): Promise<string[]> {
  const now = clock.now();
  const due = await prisma.outboxMessage.findMany({
    where: { deliveryState: 'queued', scheduledFor: { lte: now } },
    orderBy: { scheduledFor: 'asc' },
    select: { id: true },
  });
  if (!due.length) return [];

  const ids = due.map((m) => m.id);
  // Guarded on `queued` a second time, so two runs racing cannot both send the
  // same message — the database decides, not the read above. The ceiling: a run
  // that loses that race still counts the message in its return value, which
  // overstates a log line and nothing else.
  await prisma.outboxMessage.updateMany({
    where: { id: { in: ids }, deliveryState: 'queued' },
    data: { deliveryState: 'sent', sentAt: now },
  });
  return ids;
}

/**
 * A carrier said what became of a message.
 *
 * Terminal states do not move: a `delivered` that is later reported `failed`
 * is a carrier retracting evidence a fee may already rest on, and the honest
 * answer to that is to keep the first receipt and let a human look. Returns
 * whether this call was the one that settled it, so a duplicate webhook is a
 * no-op rather than an error.
 *
 * `failureCode` is a code, never a body and never a carrier's prose — the same
 * rule the inbound classifier lives by, for the same reason: this column is
 * read by roles that may not open a record.
 */
export async function recordDeliveryReceipt(
  messageId: string,
  outcome: DeliveryOutcome,
  clock: Clock = systemClock,
  failureCode?: string,
): Promise<boolean> {
  const { count } = await prisma.outboxMessage.updateMany({
    where: { id: messageId, deliveryState: { in: ['queued', 'sent'] } },
    data: {
      deliveryState: outcome,
      deliveredAt: outcome === 'delivered' ? clock.now() : null,
      failureCode: outcome === 'failed' ? (failureCode ?? 'unknown') : null,
    },
  });
  if (count === 1) return true;
  // Nothing moved: either the message is already settled, or it never existed.
  // Those are different answers and the caller is a webhook, so say which.
  if (!(await prisma.outboxMessage.count({ where: { id: messageId } }))) {
    throw new NotFound('outbox message');
  }
  return false;
}
