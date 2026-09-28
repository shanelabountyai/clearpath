import { prisma } from '../db';
import { isLocalDatabaseUrl } from '../db-guard';
import type { Actor, Role } from '../auth/permissions';
import type { Language } from '../strings';

const NO_TRUNCATE = [
  ['AuditEvent', 'audit_event_no_truncate'],
  ['NoteAmendment', 'note_amendment_no_truncate'],
] as const;

/**
 * Empties every table, audit log included. The audit and amendment tables
 * refuse TRUNCATE (review #1), so this lifts those two triggers inside its
 * own transaction only — DDL is transactional in Postgres, so a failure
 * anywhere rolls the DISABLE back too and no other session ever sees them
 * off. A remote database is refused unless CLEARPATH_ALLOW_CLOUD_DB is set,
 * which only db:seed:prod types (decided 2026-09-28: prod is synthetic demo
 * data, so a deliberate reseed resetting its history is honest).
 */
export async function resetDb() {
  const url = process.env.DATABASE_URL ?? '';
  if (!isLocalDatabaseUrl(url)) {
    if (!process.env.CLEARPATH_ALLOW_CLOUD_DB) throw new Error('resetDb refuses a non-local database');
    console.warn('  resetDb: wiping a non-local database, audit log included (CLEARPATH_ALLOW_CLOUD_DB is set).');
  }
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  if (!list) return;
  await prisma.$transaction([
    ...NO_TRUNCATE.map(([t, g]) => prisma.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${g}"`)),
    prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`),
    ...NO_TRUNCATE.map(([t, g]) => prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${g}"`)),
  ]);
}

let n = 0;
const uniq = () => `${Date.now().toString(36)}-${++n}`;

export async function makeUser(role: Role, opts: { name?: string; supervisorId?: string } = {}) {
  return prisma.user.create({
    data: {
      name: opts.name ?? `${role} ${n + 1}`,
      email: `${role}-${uniq()}@example.test`,
      role,
      supervisorId: opts.supervisorId ?? null,
    },
  });
}

export async function makeClient(
  treatingClinicianId: string,
  opts: { feeCents?: number; code?: string; language?: Language } = {},
) {
  return prisma.client.create({
    data: {
      code: opts.code ?? `TC-${uniq()}`,
      firstName: 'Test',
      lastName: `Client ${n}`,
      dateOfBirth: new Date('1990-04-12'),
      treatingClinicianId,
      feeCents: opts.feeCents ?? null,
      language: opts.language ?? 'en',
    },
  });
}

export async function makeRoom(name?: string) {
  return prisma.room.create({ data: { name: name ?? `Room ${uniq()}` } });
}

export async function settings(overrides: Record<string, unknown> = {}) {
  return prisma.practiceSettings.upsert({
    where: { id: 1 },
    create: { id: 1, ...overrides },
    update: overrides,
  });
}

export const actor = (u: { id: string; role: Role }, breakGlassReason?: string): Actor => ({
  id: u.id,
  role: u.role,
  ...(breakGlassReason ? { breakGlass: { reason: breakGlassReason } } : {}),
});
