import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requiresSecondFactor, type Actor } from './auth/permissions';
import { SESSION_ABSOLUTE_MS, resolveSession, type Resolved } from './auth/sessions';
import { systemClock } from './clock';

/**
 * The application's view of who is signed in.
 *
 * This file used to be the dev-mode user switcher, and its own comment called
 * itself "the seam where real authentication would go". This is that
 * replacement, and the seam held: every caller takes `{ actor }` off
 * `requireSession()`, so roughly fifty pages and server actions did not change
 * a line when a cookie naming a user id became a session that has to be
 * proved.
 *
 * What is left here is only the Next-facing part — cookies and redirects. The
 * decisions live in `src/auth/sessions.ts`, which knows nothing about HTTP and
 * is tested without it.
 */

export const SESSION_COOKIE = 'clearpath_session';
export const BREAK_GLASS_COOKIE = 'clearpath_break_glass';

export interface Session {
  actor: Actor;
  user: { id: string; name: string; role: Actor['role']; supervisorId: string | null };
  /**
   * The second factor, now that there is one.
   *
   * `satisfied` was documented as "a lie this build tells on purpose" —
   * always false, read by nothing. It is now the truth, and it is only ever
   * `true` here: a session that has not satisfied its second factor cannot
   * produce a `Session` at all, because `resolveSession` only attaches an
   * actor to the `ready` stage. The field stays because a surface that wants
   * to say "you are fully signed in" should not have to re-derive it.
   */
  secondFactor: { required: boolean; satisfied: boolean };
  sessionId: string;
}

const clock = systemClock;

/** The raw stage, for the sign-in flow to route on. */
export async function sessionStage(): Promise<Resolved | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? resolveSession(token, { clock }) : null;
}

/**
 * The signed-in session, or `null`.
 *
 * A half-authenticated session — password accepted, second factor not — is
 * `null` here, deliberately and by construction. There is no branch to forget:
 * only the `ready` stage carries an actor, so there is nothing to build a
 * session out of.
 */
export async function currentSession(): Promise<Session | null> {
  const resolved = await sessionStage();
  if (!resolved || resolved.stage !== 'ready') return null;

  const jar = await cookies();
  const reason = jar.get(BREAK_GLASS_COOKIE)?.value;

  return {
    user: resolved.user,
    sessionId: resolved.sessionId,
    secondFactor: { required: requiresSecondFactor(resolved.user.role), satisfied: true },
    actor: {
      ...resolved.actor,
      ...(reason ? { breakGlass: { reason } } : {}),
    },
  };
}

/**
 * Everything behind the staff shell calls this.
 *
 * Sends people to `/login`, which then decides which step of the sign-in they
 * are actually on. Routing the stages from one place is why the ~50 callers
 * here stayed a one-line `requireSession()` — none of them has to know that a
 * second factor exists.
 */
export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}

export { SESSION_ABSOLUTE_MS };
