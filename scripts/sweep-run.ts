import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { runNonResponseSweep } from '../src/scheduling/nonresponse';

/**
 * `npm run sweep:run`. Separate from `reminders:run` because the two jobs are
 * due at different moments and only this one touches money — a practice that
 * wants the loop without the charge turns off `autoNoShowOnNoResponse` and
 * still runs this, because recording the silence is the evidence.
 *
 * Counts only. P0-9: no appointment id, client id or token reaches a log line.
 */
const { noResponse, noShow, exempted } = await runNonResponseSweep(systemClock);
console.log(`no_response ${noResponse.length}, no_show ${noShow.length}, exempted ${exempted.length}`);
await prisma.$disconnect();
