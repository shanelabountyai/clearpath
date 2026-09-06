import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { receiveInbound } from '../src/messaging/inbound';

/**
 * `npm run inbound:simulate -- <from> <the message...>`
 *
 * The stub for an inbound channel, and deliberately a command rather than an
 * HTTP route. A public endpoint that writes to a client's record has to verify
 * a provider signature, and a signature nobody issues is a security control
 * that only looks like one — so the simulation is honest about being one.
 *
 * The classification is printed. The message is not, and neither is a client
 * id: the whole point of the feature is that the words end here.
 */
const [from, ...rest] = process.argv.slice(2);
const body = rest.join(' ');

if (!from || !body) {
  console.error('usage: npm run inbound:simulate -- <phone-or-email> <the message...>');
  process.exit(1);
}

const { classification, ignored } = await receiveInbound({ from, body }, { clock: systemClock });
console.log(ignored ? `${classification} — not recorded (${ignored})` : classification);
await prisma.$disconnect();
