import { prisma } from '../src/db';

/**
 * The accounts this spec makes, cleaned up by the shape of their addresses.
 *
 * Unlike the reset fixture, nothing is created here in advance: the point of
 * the spec is that the *screen* creates them, so a fixture that pre-made them
 * would be testing the teardown. What it does instead is remove whatever the
 * last run left, because an address identifies exactly one account and a
 * half-finished run would otherwise make the second one fail on "somebody
 * already has that address" — a refusal that is correct, and nothing to do with
 * what the spec is about.
 *
 * The audit rows those accounts leave behind are deliberately not removed.
 * `AuditEvent` is append-only by a database rule, and `actorId` is a plain
 * column with no foreign key precisely so a trail outlives the account it
 * names. A suite that could tidy the log would prove something weaker than one
 * that cannot.
 */
export const DOMAIN = '@accounts.spec.test';

/**
 * A distinct address per account created, because an address identifies exactly
 * one account and several of these specs create one each. Reusing a name across
 * two tests would meet "somebody here already has that address" — a refusal
 * that is correct and has nothing to do with what the second test is about.
 */
let n = 0;
export const uniqueEmail = (slug: string) =>
  `${slug}-${Date.now().toString(36)}-${++n}${DOMAIN}`;

export const CHOSEN_PASSWORD = 'accounts-spec-passphrase';

async function teardown() {
  const where = { email: { endsWith: DOMAIN } };
  const ids = (await prisma.user.findMany({ where, select: { id: true } })).map((u) => u.id);
  if (ids.length === 0) return;
  await prisma.invitation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.passwordReset.deleteMany({ where: { userId: { in: ids } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

await teardown();
await prisma.$disconnect();
