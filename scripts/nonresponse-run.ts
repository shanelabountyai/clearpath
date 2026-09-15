import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { nonResponseRun } from '../src/jobs';

/**
 * `npm run nonresponse:run`. Vercel Cron calls the same runner at :30 through
 * `app/api/cron/nonresponse`, and this is the command for anywhere else. Why
 * it is its own runner and not a second sweep on `remindersRun` is written on
 * `nonResponseRun`: this is the half with money attached, and it has to be
 * stoppable without stopping the reminders.
 *
 * Counts only. An appointment id in a log line is a client's session time in a
 * file nobody audits.
 */
const r = await nonResponseRun(systemClock);
console.log(`recorded ${r.recorded}, no-showed ${r.noShowed}`);
await prisma.$disconnect();
