import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Actor } from './auth/permissions';
import { prisma } from './db';

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
}

export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  const id = jar.get(USER_COOKIE)?.value;
  if (!id) return null;

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true, supervisorId: true, active: true },
  });
  if (!user || !user.active) return null;

  const reason = jar.get(BREAK_GLASS_COOKIE)?.value;
  return {
    user,
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

export const switchableUsers = () =>
  prisma.user.findMany({
    where: { active: true, role: { not: 'client' } },
    select: { id: true, name: true, role: true, supervisor: { select: { name: true } } },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
