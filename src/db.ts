import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

// Synthetic data only. A cloud host here would mean real infrastructure holding
// what this project promises never to hold, and would make the test suite slow
// and flaky besides.
if (/neon\.tech|rds\.amazonaws|supabase\.co|\.azure\./.test(connectionString)) {
  throw new Error('Clearpath is local-Postgres only. Refusing a remote database.');
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
