import { prisma } from '../src/db';
import { runCarrier } from '../src/messaging/delivery';

/**
 * `npm run carrier:run` — hand the outbox to the carrier and take in whatever
 * it has said since the last run. The cron a practice would put on five minutes.
 *
 * Counts only. The bodies are in the outbox and the destinations are on the
 * client record, and neither belongs in a terminal that scrolls into somebody's
 * shell history.
 */
const { settled, dispatched } = await runCarrier();

console.log(
  `dispatched ${dispatched.sent.length} sent, ${dispatched.retrying.length} retrying, `
  + `${dispatched.rejected.length} refused, ${dispatched.expired.length} expired`,
);
const delivered = settled.filter((s) => s.state === 'delivered').length;
console.log(`receipts   ${settled.length} settled, ${delivered} delivered`);

await prisma.$disconnect();
