import { readdirSync, readFileSync, statSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { fixedClock, HOUR } from '../clock';
import { makeUser, resetDb } from '../test/harness';
import { TOTP_PERIOD_SECONDS, codeForStep, stepAt } from './totp';
import { FREE_ATTEMPTS } from './lockout';
import type { Role } from './permissions';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  beginEnrolment,
  confirmEnrolment,
  resolveSession,
  revokeSessionsFor,
  setPassword,
  signIn,
  signOut,
  submitSecondFactor,
} from './sessions';

const PASSWORD = 'a-long-enough-passphrase';
const AT = '2026-03-01T09:00:00Z';

let clock = fixedClock(AT);
const deps = () => ({ clock });

beforeEach(async () => {
  await resetDb();
  clock = fixedClock(AT);
});

/** A staff account with a password set, and its email. */
async function account(role: Role) {
  const user = await makeUser(role);
  await setPassword(user.id, PASSWORD, deps());
  return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
}

/** Drive an account all the way to a usable session, second factor included. */
async function signedIn(role: Role) {
  const user = await account(role);
  const started = await signIn({ email: user.email, password: PASSWORD }, deps());
  if (!started.ok) throw new Error(`sign-in failed: ${started.reason}`);
  let token = started.token;

  if (started.stage === 'enrol_second_factor') {
    const { secret } = await beginEnrolment(token, deps());
    await confirmEnrolment(token, codeForStep(secret, stepAt(clock.now())), deps());
  } else if (started.stage === 'second_factor') {
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpSecret!;
    await submitSecondFactor(token, codeForStep(secret, stepAt(clock.now())), deps());
  }
  return { user, token };
}

describe('the password at the door', () => {
  it('lets the right one through and refuses the wrong one', async () => {
    const user = await account('front_desk');
    expect((await signIn({ email: user.email, password: PASSWORD }, deps())).ok).toBe(true);
    expect(await signIn({ email: user.email, password: 'wrong-password-here' }, deps()))
      .toEqual({ ok: false, reason: 'rejected' });
  });

  it('refuses an address that matches no account, in the same words', async () => {
    expect(await signIn({ email: 'nobody@example.test', password: PASSWORD }, deps()))
      .toEqual({ ok: false, reason: 'rejected' });
  });

  /**
   * The account created this morning that nobody has set a password on is the
   * one an attacker most wants to find. It must not be reachable, and it must
   * not announce itself by failing differently.
   */
  it('refuses an account with no password set, and does not say so', async () => {
    const user = await makeUser('therapist');
    expect(await signIn({ email: user.email, password: '' }, deps()))
      .toEqual({ ok: false, reason: 'rejected' });
    expect(await signIn({ email: user.email, password: PASSWORD }, deps()))
      .toEqual({ ok: false, reason: 'rejected' });
  });

  it('refuses a deactivated account holding a correct password', async () => {
    const user = await account('supervisor');
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect(await signIn({ email: user.email, password: PASSWORD }, deps()))
      .toEqual({ ok: false, reason: 'rejected' });
  });

  it('matches the address however it was capitalised', async () => {
    const user = await account('front_desk');
    expect((await signIn({ email: user.email.toUpperCase(), password: PASSWORD }, deps())).ok).toBe(true);
  });

  it('creates no session for a refused attempt', async () => {
    const user = await account('front_desk');
    await signIn({ email: user.email, password: 'wrong-password-here' }, deps());
    expect(await prisma.authSession.count()).toBe(0);
  });
});

describe('the token', () => {
  it('is never stored, only its hash', async () => {
    const user = await account('front_desk');
    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error('expected sign-in');

    const rows = await prisma.authSession.findMany();
    expect(rows).toHaveLength(1);
    const stored = rows[0]!.tokenHash;
    expect(stored).not.toBe(started.token);
    expect(stored).not.toContain(started.token);
    expect(started.token.length).toBeGreaterThanOrEqual(32);
  });

  it('resolves nothing when it names no session', async () => {
    expect(await resolveSession('not-a-real-token', deps())).toBeNull();
    expect(await resolveSession('', deps())).toBeNull();
  });
});

/**
 * The property the whole phase exists for. `requiresSecondFactor` was policy
 * that nothing read; a session that has only cleared a password must carry no
 * actor at all, or the second factor is decoration.
 */
describe('a session that has only cleared the password', () => {
  it('carries no actor for a role that needs a second factor', async () => {
    const user = await account('therapist');
    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error('expected sign-in');

    const resolved = await resolveSession(started.token, deps());
    expect(resolved?.stage).toBe('enrol_second_factor');
    expect(resolved).not.toHaveProperty('actor');
  });

  it('is ready immediately for a role that does not', async () => {
    const user = await account('front_desk');
    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error('expected sign-in');

    const resolved = await resolveSession(started.token, deps());
    expect(resolved?.stage).toBe('ready');
    expect(resolved).toHaveProperty('actor');
  });

  it('holds every clinical role and the practice manager behind it', async () => {
    for (const role of ['therapist', 'associate', 'supervisor', 'admin'] as Role[]) {
      await resetDb();
      const user = await account(role);
      const started = await signIn({ email: user.email, password: PASSWORD }, deps());
      if (!started.ok) throw new Error('expected sign-in');
      expect((await resolveSession(started.token, deps()))?.stage).not.toBe('ready');
    }
  });
});

describe('enrolling a second factor', () => {
  it('holds the secret on the session until a code proves it', async () => {
    const user = await account('therapist');
    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error('expected sign-in');

    const { secret, uri } = await beginEnrolment(started.token, deps());
    expect(uri).toContain(secret);
    // Not on the account yet: an enrolment abandoned here leaves no secret
    // behind rather than one nobody holds.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpSecret).toBeNull();

    await confirmEnrolment(started.token, codeForStep(secret, stepAt(clock.now())), deps());
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.totpSecret).toBe(secret);
    expect(after.totpEnrolledAt).not.toBeNull();
  });

  it('does not enrol on a wrong code', async () => {
    const user = await account('therapist');
    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error('expected sign-in');

    await beginEnrolment(started.token, deps());
    expect((await confirmEnrolment(started.token, '000000', deps())).ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpSecret).toBeNull();
    expect((await resolveSession(started.token, deps()))?.stage).toBe('enrol_second_factor');
  });

  /**
   * Enrolment is itself a use of a code, so the step it was confirmed with is
   * spent like any other. Worth asserting on its own: the alternative — an
   * enrolment that verifies but does not record — leaves the very first code a
   * new clinician generates replayable for the rest of its window.
   */
  it('spends the code it was confirmed with', async () => {
    const user = await account('therapist');
    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error('expected sign-in');
    const { secret } = await beginEnrolment(started.token, deps());
    const code = codeForStep(secret, stepAt(clock.now()));
    expect((await confirmEnrolment(started.token, code, deps())).ok).toBe(true);

    const again = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!again.ok) throw new Error('expected sign-in');
    expect(await submitSecondFactor(again.token, code, deps()))
      .toEqual({ ok: false, reason: 'replayed' });
  });

  it('makes the session usable once confirmed', async () => {
    const { token } = await signedIn('therapist');
    const resolved = await resolveSession(token, deps());
    expect(resolved?.stage).toBe('ready');
  });
});

describe('the second factor on a later sign-in', () => {
  it('is required again, on a new session', async () => {
    const { user } = await signedIn('supervisor');
    const again = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!again.ok) throw new Error('expected sign-in');
    expect(again.stage).toBe('second_factor');
    expect((await resolveSession(again.token, deps()))?.stage).toBe('second_factor');
  });

  it('accepts the current code and refuses a wrong one', async () => {
    const { user } = await signedIn('supervisor');
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpSecret!;
    clock.advance(2 * TOTP_PERIOD_SECONDS * 1000);

    const again = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!again.ok) throw new Error('expected sign-in');

    expect((await submitSecondFactor(again.token, '000000', deps())).ok).toBe(false);
    expect((await resolveSession(again.token, deps()))?.stage).toBe('second_factor');

    expect((await submitSecondFactor(again.token, codeForStep(secret, stepAt(clock.now())), deps())).ok).toBe(true);
    expect((await resolveSession(again.token, deps()))?.stage).toBe('ready');
  });

  /**
   * A code read over a shoulder is valid for the rest of its 30-second window.
   * Spending it must spend it everywhere, including in a session the attacker
   * opened themselves with a password they also have.
   */
  it('refuses a code already spent, in a different session', async () => {
    const { user } = await signedIn('supervisor');
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpSecret!;
    // Enrolment spent the step it was confirmed with, which is the replay guard
    // already working. Move to a fresh one so this spec is about the next code.
    clock.advance(2 * TOTP_PERIOD_SECONDS * 1000);
    const code = codeForStep(secret, stepAt(clock.now()));

    const mine = await signIn({ email: user.email, password: PASSWORD }, deps());
    const theirs = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!mine.ok || !theirs.ok) throw new Error('expected sign-in');

    expect((await submitSecondFactor(mine.token, code, deps())).ok).toBe(true);
    expect(await submitSecondFactor(theirs.token, code, deps()))
      .toEqual({ ok: false, reason: 'replayed' });
    expect((await resolveSession(theirs.token, deps()))?.stage).toBe('second_factor');
  });
});

describe('how long a session lasts', () => {
  it('ends when it has been idle too long', async () => {
    const { token } = await signedIn('front_desk');
    clock.advance(SESSION_IDLE_MS - 1000);
    expect((await resolveSession(token, deps()))?.stage).toBe('ready');

    clock.advance(SESSION_IDLE_MS + 1000);
    expect(await resolveSession(token, deps())).toBeNull();
  });

  it('measures idleness from the last use, not from the sign-in', async () => {
    const { token } = await signedIn('front_desk');
    for (let i = 0; i < 4; i++) {
      clock.advance(SESSION_IDLE_MS - 1000);
      expect((await resolveSession(token, deps()))?.stage).toBe('ready');
    }
  });

  it('ends at the absolute ceiling however busy it has been', async () => {
    const { token } = await signedIn('front_desk');
    const steps = Math.ceil(SESSION_ABSOLUTE_MS / (SESSION_IDLE_MS - 1000));
    let alive = true;
    for (let i = 0; i < steps + 1 && alive; i++) {
      clock.advance(SESSION_IDLE_MS - 1000);
      alive = (await resolveSession(token, deps())) !== null;
    }
    expect(alive).toBe(false);
    expect(clock.now().getTime()).toBeLessThanOrEqual(
      new Date(AT).getTime() + SESSION_ABSOLUTE_MS + SESSION_IDLE_MS,
    );
  });
});

describe('ending a session', () => {
  it('signing out stops the token working', async () => {
    const { token } = await signedIn('front_desk');
    await signOut(token, deps());
    expect(await resolveSession(token, deps())).toBeNull();
    const row = await prisma.authSession.findFirstOrThrow();
    expect(row.revokedReason).toBe('signed_out');
  });

  it('signing out of one session leaves another alone', async () => {
    const { user, token } = await signedIn('front_desk');
    const other = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!other.ok) throw new Error('expected sign-in');

    await signOut(token, deps());
    expect(await resolveSession(token, deps())).toBeNull();
    expect((await resolveSession(other.token, deps()))?.stage).toBe('ready');
  });

  /**
   * Deactivating a user is how a practice removes somebody who has left. If
   * their open session keeps working until it times out, "removed" meant
   * "removed in twelve hours".
   */
  it('deactivating a user ends their sessions now', async () => {
    const { user, token } = await signedIn('front_desk');
    await revokeSessionsFor(user.id, 'deactivated', deps());
    expect(await resolveSession(token, deps())).toBeNull();
  });

  it('a session survives nothing about the account being deactivated underneath it', async () => {
    const { user, token } = await signedIn('front_desk');
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect(await resolveSession(token, deps())).toBeNull();
  });

  it('changing a password ends every session it opened', async () => {
    const { user, token } = await signedIn('front_desk');
    await setPassword(user.id, 'a-different-long-passphrase', deps());
    expect(await resolveSession(token, deps())).toBeNull();
    expect((await prisma.authSession.findFirstOrThrow()).revokedReason).toBe('password_changed');
  });
});

describe('throttling a guessing run', () => {
  it('locks the account after the free attempts, and says how long', async () => {
    const user = await account('front_desk');
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      expect(await signIn({ email: user.email, password: 'wrong-password-here' }, deps()))
        .toEqual({ ok: false, reason: 'rejected' });
    }
    const locked = await signIn({ email: user.email, password: 'wrong-password-here' }, deps());
    expect(locked).toMatchObject({ ok: false, reason: 'locked' });
    expect((locked as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it('refuses the correct password while the lock holds', async () => {
    const user = await account('front_desk');
    for (let i = 0; i <= FREE_ATTEMPTS; i++) {
      await signIn({ email: user.email, password: 'wrong-password-here' }, deps());
    }
    const attempt = await signIn({ email: user.email, password: PASSWORD }, deps());
    expect(attempt).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('lets them back in on its own, with no administrator involved', async () => {
    const user = await account('front_desk');
    for (let i = 0; i <= FREE_ATTEMPTS; i++) {
      await signIn({ email: user.email, password: 'wrong-password-here' }, deps());
    }
    clock.advance(HOUR);
    expect((await signIn({ email: user.email, password: PASSWORD }, deps())).ok).toBe(true);
  });

  it('forgets the failures once somebody signs in', async () => {
    const user = await account('front_desk');
    await signIn({ email: user.email, password: 'wrong-password-here' }, deps());
    await signIn({ email: user.email, password: PASSWORD }, deps());
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(0);
  });
});

describe('what the audit trail says about the door', () => {
  const rows = () => prisma.auditEvent.findMany({ orderBy: { at: 'asc' } });

  it('records a sign-in, naming the account and nothing else', async () => {
    const { user } = await signedIn('front_desk');
    const [row] = (await rows()).filter((r) => r.action === 'sign_in' && r.allowed);
    expect(row).toMatchObject({ actorId: user.id, resource: 'user', resourceId: user.id });
    expect(row!.clientId).toBeNull();
  });

  it('records a refused attempt against an account that exists', async () => {
    const user = await account('front_desk');
    await signIn({ email: user.email, password: 'wrong-password-here' }, deps());
    const [row] = (await rows()).filter((r) => r.action === 'sign_in');
    expect(row).toMatchObject({ actorId: user.id, allowed: false, rule: 'password' });
  });

  /**
   * There is no account to name, and the string that was typed must not be
   * stored: people put their password in the email box, and this table is
   * append-only by database rule. So the row is not written at all.
   */
  it('writes nothing at all for an address matching no account', async () => {
    await signIn({ email: 'nobody@example.test', password: PASSWORD }, deps());
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it('never writes a password, an address or a secret into the trail', async () => {
    const { user } = await signedIn('supervisor');
    await signIn({ email: user.email, password: 'wrong-password-here' }, deps());
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpSecret!;

    const serialised = JSON.stringify(await rows());
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain('wrong-password-here');
    expect(serialised).not.toContain(user.email);
    expect(serialised).not.toContain(secret);
  });

  it('distinguishes a replayed code from a mistyped one', async () => {
    const { user } = await signedIn('supervisor');
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpSecret!;
    clock.advance(2 * TOTP_PERIOD_SECONDS * 1000);
    const code = codeForStep(secret, stepAt(clock.now()));

    const mine = await signIn({ email: user.email, password: PASSWORD }, deps());
    const theirs = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!mine.ok || !theirs.ok) throw new Error('expected sign-in');
    await submitSecondFactor(mine.token, code, deps());
    await submitSecondFactor(theirs.token, code, deps());

    const reasons = (await rows()).filter((r) => !r.allowed).map((r) => r.reason);
    expect(reasons).toContain('replayed');
  });
});

/**
 * The structural half. Behavioural specs above say the door works; these say
 * nothing was built next to it that goes around.
 */
function sourceFiles(exclude: (path: string) => boolean) {
  const out: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f)) continue;
      if (path.startsWith('src/generated/') || exclude(path)) continue;
      if (statSync(path).isFile()) out.push(path);
    }
  }
  return out;
}

/**
 * A credential column selected into a page's props is a credential in that
 * page's HTML, and it is one careless `select` away at all times. So the rule
 * is containment rather than vigilance: outside `src/auth/`, these column names
 * do not appear, which means no surface in the application can reach them even
 * by accident.
 */
it('no credential column is named outside the auth module', () => {
  const columns = /\b(passwordHash|totpSecret|pendingTotpSecret|totpLastStep|tokenHash)\b/;
  const offenders = sourceFiles((p) => p.startsWith('src/auth/')).filter((p) =>
    columns.test(readFileSync(p, 'utf8')),
  );
  expect(offenders).toEqual([]);
});

/**
 * The session cookie is a bearer token. Anything that can write it can mint a
 * session, and anything that can read it can forward one. Both stay inside the
 * sign-in flow and the adapter that owns the cookie.
 */
it('nothing outside the sign-in flow touches the session cookie', () => {
  const allowed = new Set(['src/session.ts', 'app/login/actions.ts']);
  const offenders = sourceFiles((p) => p.startsWith('src/auth/')).filter(
    (p) => !allowed.has(p) && /SESSION_COOKIE|clearpath_session/.test(readFileSync(p, 'utf8')),
  );
  expect(offenders).toEqual([]);
});

/**
 * The staff shell is gated by its layout, and a layout that fell back to
 * rendering without a session would un-gate every page under it at once — which
 * is exactly what this file used to do, when there was nothing to be signed in
 * as.
 */
it('the staff shell requires a session rather than tolerating its absence', () => {
  const layout = readFileSync('app/(staff)/layout.tsx', 'utf8');
  expect(layout).toContain('requireSession');
  expect(layout).not.toContain('currentSession');
});

/**
 * A Next layout does not wrap a route handler. The two under `(staff)` export
 * a CSV and a superbill — both client data — and they are gated only because
 * each calls `requireSession` itself, which is the kind of fact that survives
 * exactly as long as somebody remembers it.
 */
it('every route handler behind the shell authenticates itself', () => {
  const handlers = sourceFiles(() => false).filter((p) => /^app\/\(staff\)\/.*route\.tsx?$/.test(p));
  expect(handlers.length).toBeGreaterThan(0);
  const offenders = handlers.filter((p) => !readFileSync(p, 'utf8').includes('requireSession'));
  expect(offenders).toEqual([]);
});

/**
 * `requiresSecondFactor` spent five phases as policy nothing read. The whole
 * point of this one is that it is now load-bearing, and there is exactly one
 * place that reads it to decide what a session may do.
 */
it('the second-factor policy is read where sessions are decided', () => {
  expect(readFileSync('src/auth/sessions.ts', 'utf8')).toContain('requiresSecondFactor');
});
