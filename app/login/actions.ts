'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { BREAK_GLASS_COOKIE, SESSION_COOKIE } from '../../src/session';
import {
  SESSION_ABSOLUTE_MS,
  beginEnrolment,
  confirmEnrolment,
  signIn,
  signOut,
  submitSecondFactor,
} from '../../src/auth/sessions';
import { systemClock } from '../../src/clock';

const clock = systemClock;
const deps = { clock };

/**
 * Cookie settings for the session token.
 *
 * `httpOnly` so script cannot read it, `sameSite: 'lax'` so it does not ride
 * along on a cross-site POST, and `secure` outside development because a
 * bearer token on plain HTTP is a bearer token anybody on the network holds.
 * `maxAge` matches the server-side ceiling — the browser forgetting it is a
 * convenience, the `expiresAt` column is the actual rule.
 */
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
  maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
} as const;

/**
 * What the sign-in form shows back.
 *
 * One sentence for every refusal that is not a lockout, because "no such
 * account" and "wrong password" must be indistinguishable to whoever is
 * typing. The lockout is the one exception, and it is told plainly: somebody
 * locked out needs to know to wait rather than to keep trying.
 */
export type LoginState = { error?: string } | undefined;

const SAME_ANSWER = 'That email and password do not match an account here.';

export async function submitPassword(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');

  const result = await signIn({ email, password }, deps);
  if (!result.ok) {
    if (result.reason === 'locked') {
      const minutes = Math.max(1, Math.ceil(result.retryAfterMs / 60_000));
      return {
        error: `Too many attempts. This account is locked for ${minutes} minute${minutes === 1 ? '' : 's'}. It unlocks on its own — nobody has to reset it for you.`,
      };
    }
    return { error: SAME_ANSWER };
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, result.token, cookieOptions);
  // A new sign-in never inherits an emergency justification from whoever used
  // this browser last. Break-glass is declared per session, with a reason.
  jar.delete(BREAK_GLASS_COOKIE);

  revalidatePath('/', 'layout');
  redirect(result.stage === 'ready' ? '/' : '/login');
}

export async function submitCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');

  const result = await submitSecondFactor(token, String(form.get('code') ?? ''), deps);
  if (!result.ok) {
    if (result.reason === 'no_session') redirect('/login');
    // A replayed code and a mistyped one get the same sentence. The difference
    // is worth recording in the audit trail — somebody reusing a code is not
    // somebody fumbling one — but telling the person at the keyboard which it
    // was would tell an attacker their captured code had been spent already.
    return { error: 'That code is not right. Codes change every 30 seconds — try the one showing now.' };
  }

  revalidatePath('/', 'layout');
  redirect('/');
}

export async function submitEnrolment(_prev: LoginState, form: FormData): Promise<LoginState> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');

  const result = await confirmEnrolment(token, String(form.get('code') ?? ''), deps);
  if (!result.ok) {
    if (result.reason === 'no_session') redirect('/login');
    return { error: 'That code did not match. Check the app has finished adding the account, then try the code showing now.' };
  }

  revalidatePath('/', 'layout');
  redirect('/');
}

/** The secret to show on the enrolment screen, generated once per session. */
export async function enrolmentSecret(): Promise<{ secret: string; uri: string }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');
  return beginEnrolment(token, deps);
}

export async function signOutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await signOut(token, deps);

  jar.delete(SESSION_COOKIE);
  jar.delete(BREAK_GLASS_COOKIE);
  revalidatePath('/', 'layout');
  redirect('/login');
}
