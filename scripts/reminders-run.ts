import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { runReminderHorizon } from '../src/scheduling/reminders';
import { runLeaveAlertSweep } from '../src/staff/leave-plan';

/**
 * `npm run reminders:run`. A cron entry, a systemd timer or a hosted scheduler
 * calls this; none of them is a dependency, because the cadence is due-date
 * driven rather than tick driven. Running it twice is the same as running it
 * once, so a missed hour costs nothing but lateness.
 *
 * The leave alert sweep rides here and not on `purge:run` (leave Phase 3). It
 * has this runner's property exactly — idempotent, and late rather than wrong
 * when missed — and lateness is its whole cost: an unread critical alert
 * waiting for a nightly purge could sit with somebody away for most of a day.
 * `purge:run` shares a schedule because its sweeps destroy data; this one
 * destroys nothing.
 */
const { queued, promoted, exempted } = await runReminderHorizon(systemClock);
const moved = await runLeaveAlertSweep(systemClock);
console.log(`queued ${queued.length}, promoted ${promoted.length}, exempted ${exempted.length}, alerts moved ${moved.length}`);
await prisma.$disconnect();
