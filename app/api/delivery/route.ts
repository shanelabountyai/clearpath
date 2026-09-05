import { NextResponse } from 'next/server';
import { systemClock } from '../../../src/clock';
import { recordReceipt } from '../../../src/messaging/delivery';
import type { DeliveryFailure, DeliveryState } from '../../../src/messaging/carrier';

/**
 * Where a carrier says whether the message arrived.
 *
 * The other half of `/api/inbound`, and deliberately behind its **own** secret.
 * A delivery-receipt credential should not also be able to cancel somebody's
 * appointment, which is what `/api/inbound` can do — sharing one secret between
 * the two would hand every provider that reports a receipt the ability to
 * decline a session on a client's behalf. Two endpoints, two capabilities, two
 * keys.
 *
 * With `DELIVERY_WEBHOOK_SECRET` unset the route refuses everything rather than
 * defaulting to open. The failure mode that matters is the quiet one: an
 * endpoint that works without its secret is an endpoint nobody notices is
 * unauthenticated, and this one decides whether a fee has its evidence.
 *
 * The route decides nothing. It validates the vocabulary and hands over, so the
 * state machine lives in one module rather than in whichever endpoint a
 * provider happened to be wired to.
 */

const STATES: readonly DeliveryState[] = ['queued', 'sent', 'delivered', 'failed'];
const FAILURES: readonly DeliveryFailure[] = [
  'invalid_destination', 'unreachable', 'rejected', 'opted_out_at_carrier', 'carrier_unavailable', 'expired',
];

export async function POST(request: Request) {
  const secret = process.env.DELIVERY_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Delivery webhook is not configured' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const providerRef = typeof payload?.providerRef === 'string' ? payload.providerRef : '';
  const state = payload?.state as DeliveryState;
  if (!providerRef) return NextResponse.json({ error: 'Missing providerRef' }, { status: 400 });
  if (!STATES.includes(state)) return NextResponse.json({ error: 'Unknown state' }, { status: 400 });

  // A code this codebase does not know is refused rather than stored. The
  // alternative — keeping the provider's own string — is how a carrier's error
  // text, which routinely quotes the message and the destination back at you,
  // ends up in an operational table nobody thought of as holding either.
  const failureCode = payload?.failureCode ?? null;
  if (failureCode !== null && !FAILURES.includes(failureCode)) {
    return NextResponse.json({ error: 'Unknown failure code' }, { status: 400 });
  }

  // Receipts are ordered by the carrier's clock, so a provider that sends no
  // timestamp is a provider whose ordering we are inventing. Arrival time is
  // the least-wrong proxy and it comes from the injected clock like everything
  // else — never a bare wall-time read, which the clock lint would catch anyway.
  const occurredAt = payload?.occurredAt ? new Date(payload.occurredAt) : systemClock.now();
  if (Number.isNaN(occurredAt.getTime())) {
    return NextResponse.json({ error: 'Unreadable timestamp' }, { status: 400 });
  }

  const result = await recordReceipt({ providerRef, state, failureCode, occurredAt });

  // A reference this practice never issued is not an error the caller can fix,
  // and a 500 would make the provider replay it forever. 202: heard, kept nothing.
  if (!result) return NextResponse.json({ matched: false }, { status: 202 });

  return NextResponse.json({ matched: true, state: result.state, applied: result.applied });
}
