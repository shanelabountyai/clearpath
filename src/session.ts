import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requiresSecondFactor, type Actor } from './auth/permissions';
import { prisma } from './db';
import { verifyBreakGlass } from './break-glass-cookie';

/**
 * The dev-mode user switcher.
 *
 * There is no authentication in Clearpath, on purpose: auth is its own project
 * and bolting on a half-version would make the access-control work harder to
 * read, not easier. What matters here is that *authorization* is real, and it
 * is — the actor this returns goes through the same permission matrix a logged
 * in user would.
 *
 * This is the seam. A real deployment replaces this file and nothing else.
 */
export const USER_COOKIE = 'clearpath_user';
export const BREAK_GLASS_COOKIE = 'clearpath_break_glass';

export interface Session {
  actor: Actor;
  user: { id: string; name: string; role: Actor['role']; supervisorId: string | null };
  /**
   * Where the second factor would be checked.
   *
   * `required` is real policy, read from the permission module. `satisfied` is
   * a lie this build tells on purpose: there is no authentication here, so
   * there is nothing to satisfy, and pretending otherwise by writing a check
   * that always passes would look like a feature. It is surfaced in the person
   * picker instead, so the gap is visible in the product rather than buried in
   * a comment — see WRITEUP.md, "Where authentication would attach".
   */
  secondFactor: { required: boolean; satisfied: boolean };
}

export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  const id = jar.get(USER_COOKIE)?.value;
  if (!id) return null;

  // The picker's own rule, not just its own list: a hand-set cookie naming a
  // client-role user or a deactivated one is nobody (SEC-03).
  const user = await prisma.user.findFirst({
    where: { id, ...SWITCHABLE },
    select: { id: true, name: true, role: true, supervisorId: true },
  });
  if (!user) return null;

  // A break-glass cookie only counts if `startBreakGlass` signed it for this
  // user; a hand-set one has no audit row behind it.
  const rawReason = jar.get(BREAK_GLASS_COOKIE)?.value;
  const reason = rawReason ? verifyBreakGlass(user.id, rawReason) : null;
  return {
    user,
    secondFactor: { required: requiresSecondFactor(user.role), satisfied: false },
    actor: {
      id: user.id,
      role: user.role,
      ...(reason ? { breakGlass: { reason } } : {}),
    },
  };
}

export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  // Nobody selected yet, or the cookie points at a user who has been
  // deactivated. Either way it is the person picker, not a stack trace.
  if (!session) redirect('/');
  return session;
}

const SWITCHABLE = { active: true, role: { not: 'client' } } as const;

export const isSwitchable = async (id: string) =>
  id !== '' && (await prisma.user.count({ where: { id, ...SWITCHABLE } })) === 1;

export const switchableUsers = () =>
  prisma.user.findMany({
    where: SWITCHABLE,
    select: {
      id: true, name: true, role: true, supervisor: { select: { name: true } },
      // P0-9's second notice effect: somebody leaving is marked, with the day.
      departures: { where: { status: 'planned' }, select: { id: true, lastDayOn: true } },
    },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
