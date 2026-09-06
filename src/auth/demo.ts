/**
 * The password every seeded staff account gets.
 *
 * A constant in the source tree, which would be indefensible anywhere else and
 * is the only honest option here: this project holds synthetic data and its
 * first promise is that it holds nothing real. A password nobody can find
 * would make the deployed demo unopenable; a password generated per seed run
 * would make the e2e suite reach into the database to log in, which is the
 * suite proving something other than the login.
 *
 * It is long enough to satisfy the same `passwordComplaint` rule staff meet,
 * because a seed that bypasses the policy is a seed that stops testing it.
 */
export const DEMO_PASSWORD = 'stillwater-demo-passphrase';

/**
 * The seeded staff accounts, for the sign-in screen's demo panel.
 *
 * It lives in the auth module for one structural reason: it is the only query
 * in the application that needs to name `passwordHash`, and the lint in
 * `sessions.test.ts` refuses that column anywhere outside `src/auth/`. A page
 * that can select a credential column is a page that can leak one into its own
 * HTML, so the rule is that credentials are not reachable from the rest of the
 * tree at all — not "are not currently read there".
 */
export async function demoAccounts() {
  const { prisma } = await import('../db');
  return prisma.user.findMany({
    where: { active: true, role: { not: 'client' }, passwordHash: { not: null } },
    select: { name: true, email: true, role: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
}
