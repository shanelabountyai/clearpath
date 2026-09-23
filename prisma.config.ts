import { defineConfig } from 'prisma/config';
import { isLocalDatabaseUrl } from './src/db-guard';

// Prisma 7 no longer auto-loads .env. Test runs inject DATABASE_URL themselves
// via `dotenv -e .env.test`; this covers the plain CLI in development.
if (!process.env.DATABASE_URL) {
  const { config } = await import('dotenv');
  config({ path: '.env', quiet: true });
}

const url = process.env.DATABASE_URL!;
// The deployed demo runs on Neon and holds exactly what `npm run db:seed` writes:
// the same fake practice, no real data to leak. What this guard is actually for is
// a laptop — a mistyped .env.test pointing a sweep or a migration at a cloud branch,
// which is an accident and never announces itself. So the exemption is an explicit
// variable on top of a loopback allow-list: reaching a cloud database has to be a
// thing someone typed, and `db:migrate:prod` / `db:seed:prod` are where it is typed.
if (!process.env.CLEARPATH_ALLOW_CLOUD_DB && !isLocalDatabaseUrl(url)) {
  throw new Error('Clearpath is synthetic-data only: local Postgres, never a cloud database.');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url, shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL },
  migrations: { seed: 'npx tsx prisma/seed.ts' },
});
