import { prisma } from '../db';
import type { Actor, Role } from '../auth/permissions';
import type { Carrier } from '../messaging/carrier';
import { dispatchOutbox, recordReceipt } from '../messaging/delivery';

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

/**
 * A carrier that takes everything and loses nothing. Not the shipped simulated
 * driver, which fails a deterministic slice on purpose — a fixture that is
 * about the fee should not also be a lottery on whether the message arrived.
 */
const perfectCarrier: Carrier = {
  name: 'test',
  send: async (message) => ({ providerRef: `test_${message.id}`, accepted: true }),
};

/**
 * Push everything currently queued all the way to `delivered`.
 *
 * The non-response fee reads a delivery receipt, so a fixture that queues a
 * reminder and stops is a fixture the sweep will exempt — correctly, and
 * invisibly. Specs that are about something else call this and move on; specs
 * that are about delivery drive the carrier themselves.
 */
export async function deliverOutbox(at: Date) {
  const clock = { now: () => at };
  await dispatchOutbox({ clock, carrier: perfectCarrier });

  const sent = await prisma.outboxMessage.findMany({
    where: { deliveryState: 'sent' },
    select: { providerRef: true },
  });
  for (const { providerRef } of sent) {
    if (providerRef) await recordReceipt({ providerRef, state: 'delivered', occurredAt: at }, { clock });
  }
}
