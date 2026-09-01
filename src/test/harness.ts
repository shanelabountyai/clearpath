import { prisma } from '../db.js';
import type { Actor, Role } from '../auth/permissions.js';

/**
 * Empties every table. TRUNCATE is deliberately still permitted on the audit
 * log — the append-only trigger blocks UPDATE and DELETE, the two ways a row
 * gets quietly rewritten, while wiping the whole table between tests is an
 * obviously-administrative act that no application code path can perform.
 */
export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
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

export async function makeClient(treatingClinicianId: string, opts: { feeCents?: number; code?: string } = {}) {
  return prisma.client.create({
    data: {
      code: opts.code ?? `TC-${uniq()}`,
      firstName: 'Test',
      lastName: `Client ${n}`,
      dateOfBirth: new Date('1990-04-12'),
      treatingClinicianId,
      feeCents: opts.feeCents ?? null,
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
