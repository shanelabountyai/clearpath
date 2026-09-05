import { prisma } from '../src/db';
import { handleInboundReply } from '../src/messaging/inbound';

/**
 * `npm run inbound:simulate -- <from> <body...>` — a client texting back,
 * without a carrier. The same entry point the HTTP route calls.
 *
 * Counts and a classification only, like every other job in this project: the
 * body is the thing this feature exists not to keep, and echoing it into a
 * terminal that scrolls into somebody's shell history would be a poor start.
 */
const [from, ...rest] = process.argv.slice(2);
if (!from) {
  console.error('usage: npm run inbound:simulate -- <phone-or-email> <message>');
  process.exit(1);
}

const reply = await handleInboundReply({ from, body: rest.join(' ') });
console.log(`classified as ${reply.classification}${reply.appointmentId ? ', against one open question' : ''}`);
await prisma.$disconnect();
