import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { purgeRun } from '../src/jobs';

/**
 * `npm run purge:run`. Vercel Cron calls the same runner daily through
 * `app/api/cron/purge`. Why both retention sweeps share it is written on
 * `purgeRun`.
 */
const r = await purgeRun(systemClock);
console.log(`purged ${r.inquiries} inquiries, ${r.processNotes} process notes`);
await prisma.$disconnect();
