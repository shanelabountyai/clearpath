import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { runReminderHorizon } from '../src/scheduling/reminders';

/**
 * `npm run reminders:run`. A cron entry, a systemd timer or a hosted scheduler
 * calls this; none of them is a dependency, because the cadence is due-date
 * driven rather than tick driven. Running it twice is the same as running it
 * once, so a missed hour costs nothing but lateness.
 */
const { queued, promoted, exempted } = await runReminderHorizon(systemClock);
console.log(`queued ${queued.length}, promoted ${promoted.length}, exempted ${exempted.length}`);
await prisma.$disconnect();
