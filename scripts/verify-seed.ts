import { prisma } from '../src/db';
import { assertSeedMetrics } from '../prisma/metrics';

/**
 * `npm run verify:seed`. The same assertions the seed makes on its way out,
 * runnable against a database that already exists — after a migration, after a
 * deploy, or when somebody wants to know whether the demo data still means
 * what the write-up says it means.
 */
console.log('\nThe seeded quarter, against its own success metrics.\n');
await assertSeedMetrics((m) => console.log(`  ${m}`));
console.log('\nAll metrics hold.\n');
await prisma.$disconnect();
