import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { dispatchOutbox, recordDeliveryReceipt } from '../src/messaging/delivery';

/**
 * `npm run delivery:run`. The carrier that does not exist, standing in for the
 * one that will.
 *
 * Two steps rather than one, because they are two events with a gap between
 * them that is the whole point of the feature: this process hands a message
 * over, and some time later the carrier says what became of it. A real
 * integration replaces the first half with an API call and the second half with
 * a signed webhook — and until it does, this script is the only thing that can
 * move a message to `delivered`, which is deliberate: the fee depends on that
 * state, so nothing should reach it by accident.
 *
 * This stub always succeeds. Failures are real and are reachable — a `failed`
 * receipt is one call to `recordDeliveryReceipt` — but a stub that invents them
 * at random would make the seeded fee totals unreproducible, and a fixture that
 * only probably exists is a spec that only probably means anything.
 *
 * Counts only, like the other two. An id in a log line is a client's message.
 */
const sent = await dispatchOutbox(systemClock);
let delivered = 0;
for (const id of sent) {
  if (await recordDeliveryReceipt(id, 'delivered', systemClock)) delivered++;
}
console.log(`sent ${sent.length}, delivered ${delivered}`);
await prisma.$disconnect();
