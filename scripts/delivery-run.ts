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
 * No cron entry, and not because nobody got round to it. `dispatchOutbox` is
 * schedulable on its own — idempotent, guarded on `queued` a second time in
 * SQL, the same shape as the reminder horizon. The receipt half is not: it
 * marks every message `delivered` with no carrier having said so, and
 * `nonresponse.ts` rests a no-show fee on exactly that state. A cron entry
 * here would therefore be a job that fabricates the evidence for a charge,
 * unattended, every hour — the failure `delivery.ts` was written to prevent,
 * rebuilt as infrastructure. `nonresponse:run` is scheduled and this is not,
 * which is the whole distinction: one reads evidence, this one invents it.
 *
 * So it stays a command somebody runs, on a demo whose messages nobody is
 * really sending — and a deployment where nothing reaches `delivered` records
 * silence with reason `no_response_undelivered` and charges nobody, which is
 * the correct answer rather than a gap. When a carrier exists the two halves
 * separate: `dispatchOutbox` takes the cron entry, and the receipt becomes the
 * webhook `recordDeliveryReceipt` is already shaped for.
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
