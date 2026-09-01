import { defineConfig } from 'prisma/config';

// Prisma 7 no longer auto-loads .env. Test runs inject DATABASE_URL themselves
// via `dotenv -e .env.test`; this covers the plain CLI in development.
if (!process.env.DATABASE_URL) {
  const { config } = await import('dotenv');
  config({ path: '.env', quiet: true });
}

const url = process.env.DATABASE_URL!;
if (/neon\.tech|rds\.amazonaws|supabase\.co/.test(url)) {
  throw new Error('Clearpath is synthetic-data only: local Postgres, never a cloud database.');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url, shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL },
  migrations: { seed: 'npx tsx prisma/seed.ts' },
});
