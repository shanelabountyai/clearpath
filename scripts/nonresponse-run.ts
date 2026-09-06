import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { runNonResponseSweep } from '../src/scheduling/nonresponse';

/**
 * `npm run nonresponse:run`. The other half of the loop, and the half with
 * money attached — so it is a separate command from `reminders:run`, run on a
 * different schedule, and it can be stopped without stopping the reminders.
 *
 * Counts only. An appointment id in a log line is a client's session time in a
 * file nobody audits.
 */
const { recorded, noShowed } = await runNonResponseSweep(systemClock);
console.log(`recorded ${recorded.length}, no-showed ${noShowed.length}`);
await prisma.$disconnect();
