import { NextResponse } from 'next/server';
import { handleInboundReply } from '../../../src/messaging/inbound';
import { NotFound } from '../../../src/errors';

/**
 * The seam a carrier attaches to.
 *
 * A real SMS provider POSTs here when a client texts back. Nothing about the
 * shape of that is simulated — what is simulated is that no provider is
 * attached, so the only thing that ever calls it is `npm run inbound:simulate`
 * and the e2e sweep.
 *
 * The route classifies nothing and decides nothing. It reads two fields, hands
 * them to `handleInboundReply`, and returns the classification — so the rule
 * about what may be stored lives in one module rather than in whatever endpoint
 * a provider happened to be wired to.
 *
 * **This is the one write endpoint in the application without a session behind
 * it**, and it can cancel an appointment, so it is not left open the way the
 * dev-mode user switcher is. A shared secret in the `Authorization` header is
 * checked here; with `INBOUND_WEBHOOK_SECRET` unset the route refuses every
 * request rather than defaulting to open, because a webhook that quietly works
 * without its secret is a webhook nobody notices is unauthenticated.
 *
 * The honest gap, named rather than papered over: a shared secret proves the
 * *caller* is the carrier and says nothing about whether the carrier was told
 * the truth about who sent the message. A real integration verifies a signed
 * payload and, for anything more consequential than this, would not treat a
 * phone number as authentication at all.
 */
export async function POST(request: Request) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Inbound webhook is not configured' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const from = typeof payload?.from === 'string' ? payload.from : '';
  const body = typeof payload?.body === 'string' ? payload.body : '';
  if (!from) return NextResponse.json({ error: 'Missing sender' }, { status: 400 });

  try {
    const reply = await handleInboundReply({ from, body });
    // The classification, and never an echo of what arrived. A response body
    // repeating the message would put it in the carrier's logs, which is the
    // same leak by a longer route.
    return NextResponse.json({
      classification: reply.classification,
      appointmentId: reply.appointmentId,
    });
  } catch (e) {
    // An address the practice does not know is not an error worth detail: the
    // reply names nobody, so there is nothing to say about whether they exist.
    if (e instanceof NotFound) return NextResponse.json({ error: 'Unknown sender' }, { status: 404 });
    throw e;
  }
}
