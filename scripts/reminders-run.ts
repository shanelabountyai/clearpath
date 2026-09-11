import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { remindersRun } from '../src/jobs';

/**
 * `npm run reminders:run`. Vercel Cron calls the same runner hourly through
 * `app/api/cron/reminders`, and this is the command for anywhere else. The
 * cadence is due-date driven rather than tick driven, so running it twice is
 * the same as running it once, and a missed hour costs only lateness.
 */
const r = await remindersRun(systemClock);
console.log(`queued ${r.queued}, promoted ${r.promoted}, exempted ${r.exempted}, alerts moved ${r.alertsMoved}`);
await prisma.$disconnect();
