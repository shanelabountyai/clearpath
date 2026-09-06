import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db';
import type { Clock } from '../clock';
import { authEvent } from './guard';
import { lockoutRemaining, lockoutUntil } from './lockout';
import { ABSENT_ACCOUNT_HASH, hashPassword, verifyPassword } from './password';
import { requiresSecondFactor, type Actor, type Role } from './permissions';
import { generateSecret, otpauthUri, stepAt, verifyTotp } from './totp';

/**
 * Sign-in, and the session it produces.
 *
 * The previous build had no authentication at all and said so: a cookie naming
 * a user id, and a comment calling itself the seam. What replaces it is a
 * session the holder cannot forge — an opaque random token whose SHA-256 is
 * what the database stores — because a password guarding a cookie anybody can
 * type is a lock on a door with no wall beside it.
 *
 * The shape that matters is `Resolved`: only the `ready` stage carries an
 * `Actor`. A session that has cleared a password and not a second factor is
 * representable, but there is no way to get an actor out of it, so no caller
 * can accidentally authorize from a half-finished sign-in. That is the whole
 * enforcement of `requiresSecondFactor`, and it is a type rather than a check
 * somebody has to remember to write.
 *
 * Time arrives through the injected clock, per hard rule 7. Expiry, idle
 * timeout, lockout and TOTP steps are all testable by moving it.
 */

/** A working day. A session does not outlive this however active it has been. */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;
/**
 * Idle timeout. Thirty minutes is a session length, not a paranoid one: these
 * are shared consulting rooms and a front-desk machine in a waiting area, and
 * the thing being left open is a client's record.
 */
export const SESSION_IDLE_MS = 30 * 60_000;

const TOKEN_BYTES = 32;

export interface Deps {
  clock: Clock;
}

/** Where a sign-in has got to. `ready` is the only one that authorizes. */
export type Stage = 'ready' | 'second_factor' | 'enrol_second_factor';

export type SignInResult =
  | { ok: true; token: string; stage: Stage }
  | { ok: false; reason: 'rejected' }
  | { ok: false; reason: 'locked'; retryAfterMs: number };

interface SessionUser {
  id: string;
  name: string;
  role: Role;
  email: string;
  supervisorId: string | null;
}

export type Resolved =
  /** Fully authenticated. The only variant carrying an actor. */
  | { stage: 'ready'; sessionId: string; user: SessionUser; actor: Actor }
  | { stage: 'second_factor'; sessionId: string; user: SessionUser }
  | { stage: 'enrol_second_factor'; sessionId: string; user: SessionUser };

const USER_FIELDS = {
  id: true, name: true, role: true, email: true, supervisorId: true,
} as const;

/** The token is a bearer credential; only its digest is ever written down. */
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Which stage an authenticated user is at, given what they have enrolled.
 *
 * The one place `requiresSecondFactor` is read, and the reason a role that
 * needs a factor but has not enrolled lands on `enrol_second_factor` rather
 * than `ready`: "no secret yet" must be a mandatory next step, never a way
 * past the check. A clinical account reachable with one factor because nobody
 * finished setup is the failure mode this ordering exists to close.
 */
function stageFor(user: { role: Role; totpSecret: string | null }, secondFactorAt: Date | null): Stage {
  if (!requiresSecondFactor(user.role)) return 'ready';
  if (!user.totpSecret) return 'enrol_second_factor';
  return secondFactorAt ? 'ready' : 'second_factor';
}

/**
 * Set or replace an account's password, ending every session it had opened.
 *
 * Revoking on change is what makes a password reset a remedy: if the reason
 * you are changing it is that somebody else has it, leaving their session
 * running until it times out means the change did nothing for twelve hours.
 */
export async function setPassword(userId: string, plain: string, { clock }: Deps): Promise<void> {
  const passwordHash = await hashPassword(plain);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    await tx.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: clock.now(), revokedReason: 'password_changed' },
    });
  });
}

/** End every live session for a user. `reason` is a code, not a sentence. */
export async function revokeSessionsFor(userId: string, reason: string, { clock }: Deps): Promise<void> {
  await prisma.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: clock.now(), revokedReason: reason },
  });
}

/**
 * Verify an email and password, and open a session if they are right.
 *
 * Every refusal that is not a lockout returns the identical `rejected`, and an
 * address matching no account still costs a full scrypt against
 * `ABSENT_ACCOUNT_HASH`. Both halves are the same defence: a login that
 * distinguishes "no such person" from "wrong password" — in its words or in
 * its timing — hands over the staff list.
 */
export async function signIn(
  { email, password }: { email: string; password: string },
  { clock }: Deps,
): Promise<SignInResult> {
  const now = clock.now();
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: 'insensitive' } },
    select: {
      ...USER_FIELDS, active: true, passwordHash: true, totpSecret: true,
      failedLoginCount: true, lockedUntil: true,
    },
  });

  // No account, or one that cannot sign in. Do the work anyway so the timing
  // says nothing, and write no audit row: there is nothing to name, and the
  // string that was typed must not be stored — people put their password in
  // the email box, and the audit table is append-only by database rule.
  if (!user || !user.active) {
    await verifyPassword(password, ABSENT_ACCOUNT_HASH);
    return { ok: false, reason: 'rejected' };
  }

  const subject = { id: user.id, role: user.role };

  const remaining = lockoutRemaining(user.lockedUntil, now);
  if (remaining > 0) {
    // Refused before the password is even considered, so a lock is not a
    // password oracle that answers one guess per window.
    await authEvent(subject, 'sign_in', { allowed: false, rule: 'lockout', reason: 'locked' });
    return { ok: false, reason: 'locked', retryAfterMs: remaining };
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    const failedLoginCount = user.failedLoginCount + 1;
    const locked = lockoutUntil(failedLoginCount, now);
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount, lockedUntil: locked },
    });
    await authEvent(subject, 'sign_in', {
      allowed: false,
      rule: 'password',
      reason: locked ? 'locked' : 'rejected',
    });
    // Say so on the attempt that trips the lock, not on the next one. Somebody
    // who mistyped four times and is then told "wrong password" a fifth time
    // when they typed it correctly learns the wrong lesson about their own
    // memory, and a lock nobody is told about gets reported as an outage.
    return locked
      ? { ok: false, reason: 'locked', retryAfterMs: lockoutRemaining(locked, now) }
      : { ok: false, reason: 'rejected' };
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const stage = stageFor(user, null);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });
    await tx.authSession.create({
      data: {
        userId: user.id,
        tokenHash: digest(token),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
        // A role with no second factor to satisfy has satisfied it. Recording
        // the moment rather than leaving null keeps "is this session whole"
        // one comparison instead of one comparison and a role lookup.
        secondFactorAt: stage === 'ready' ? now : null,
      },
    });
    await authEvent(subject, 'sign_in', {
      allowed: true,
      rule: 'password',
      reason: stage === 'ready' ? 'signed_in' : stage,
    }, tx);
  });

  return { ok: true, token, stage };
}

/**
 * Load the session a token names, or `null` if it is not usable.
 *
 * Not usable covers: unknown token, revoked, past its absolute expiry, idle
 * too long, and an account deactivated since it opened. The last is why this
 * joins the user rather than trusting the session row — a practice removing
 * somebody who has left should not have to wait out their idle timeout.
 *
 * Advances `lastSeenAt`, so the idle window runs from the last use.
 */
export async function resolveSession(token: string, { clock }: Deps): Promise<Resolved | null> {
  if (!token) return null;
  const now = clock.now();

  const session = await prisma.authSession.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: { select: { ...USER_FIELDS, active: true, totpSecret: true } } },
  });

  if (!session || session.revokedAt) return null;
  if (!session.user.active) return null;
  if (session.expiresAt <= now) return null;
  if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_IDLE_MS) return null;

  await prisma.authSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });

  const { active: _active, totpSecret, ...user } = session.user;
  const stage = stageFor({ role: user.role, totpSecret }, session.secondFactorAt);
  if (stage !== 'ready') return { stage, sessionId: session.id, user };

  return {
    stage: 'ready',
    sessionId: session.id,
    user,
    // Break-glass is layered on by the caller that owns the cookie; this
    // module says who you are, not what emergency you have declared.
    actor: { id: user.id, role: user.role },
  };
}

export type FactorResult = { ok: true } | { ok: false; reason: 'mismatch' | 'replayed' | 'malformed' | 'not_enrolled' | 'no_session' };

/**
 * Answer the second-factor challenge.
 *
 * The accepted step is written to the *account*, not the session, so a code
 * spent here cannot be spent again anywhere — including in a second session an
 * attacker opened with a password they also hold. That case is the reason the
 * replay guard exists, and it is what `sessions.test.ts` asserts directly.
 */
export async function submitSecondFactor(token: string, code: string, { clock }: Deps): Promise<FactorResult> {
  const now = clock.now();
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: { select: { id: true, role: true, active: true, totpSecret: true, totpLastStep: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt <= now || !session.user.active) {
    return { ok: false, reason: 'no_session' };
  }

  const { user } = session;
  const result = verifyTotp({
    secret: user.totpSecret,
    code,
    at: now,
    afterStep: user.totpLastStep === null ? null : Number(user.totpLastStep),
  });

  if (!result.ok) {
    await authEvent({ id: user.id, role: user.role }, 'sign_in', {
      allowed: false,
      rule: 'second_factor',
      reason: result.reason,
    });
    return result;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { totpLastStep: BigInt(result.step) } });
    await tx.authSession.update({
      where: { id: session.id },
      data: { secondFactorAt: now, lastSeenAt: now },
    });
    await authEvent({ id: user.id, role: user.role }, 'sign_in', {
      allowed: true, rule: 'second_factor', reason: 'signed_in',
    }, tx);
  });

  return { ok: true };
}

/**
 * Start enrolment: a fresh secret, held on the session until a code proves it.
 *
 * Returned to be shown once. It is deliberately not written to the account
 * here — see `AuthSession.pendingTotpSecret` — so a person who closes the tab
 * halfway is not left with an account demanding codes from an authenticator
 * they never finished adding.
 */
export async function beginEnrolment(token: string, { clock }: Deps): Promise<{ secret: string; uri: string }> {
  const now = clock.now();
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: { select: { email: true, totpSecret: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) {
    throw new Error('no session to enrol against');
  }
  if (session.user.totpSecret) throw new Error('already enrolled');

  // Reuse the secret already generated for this session, so a reload does not
  // invalidate the QR code the person is halfway through scanning.
  const secret = session.pendingTotpSecret ?? generateSecret();
  if (secret !== session.pendingTotpSecret) {
    await prisma.authSession.update({ where: { id: session.id }, data: { pendingTotpSecret: secret } });
  }

  return { secret, uri: otpauthUri({ secret, account: session.user.email }) };
}

/** Prove the pending secret with a code from it, and promote it to the account. */
export async function confirmEnrolment(token: string, code: string, { clock }: Deps): Promise<FactorResult> {
  const now = clock.now();
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: { select: { id: true, role: true, active: true, totpSecret: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt <= now || !session.user.active) {
    return { ok: false, reason: 'no_session' };
  }
  if (session.user.totpSecret) return { ok: false, reason: 'not_enrolled' };

  const result = verifyTotp({ secret: session.pendingTotpSecret, code, at: now });
  if (!result.ok) {
    await authEvent({ id: session.user.id, role: session.user.role }, 'enrol_second_factor', {
      allowed: false, rule: 'second_factor', reason: result.reason,
    });
    return result;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: session.user.id },
      data: {
        totpSecret: session.pendingTotpSecret,
        totpEnrolledAt: now,
        totpLastStep: BigInt(result.step),
      },
    });
    await tx.authSession.update({
      where: { id: session.id },
      data: { secondFactorAt: now, lastSeenAt: now, pendingTotpSecret: null },
    });
    await authEvent({ id: session.user.id, role: session.user.role }, 'enrol_second_factor', {
      allowed: true, rule: 'second_factor', reason: 'enrolled',
    }, tx);
  });

  return { ok: true };
}

/** End this session, and only this one. Other devices stay signed in. */
export async function signOut(token: string, { clock }: Deps): Promise<void> {
  const now = clock.now();
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: { select: { id: true, role: true } } },
  });
  if (!session || session.revokedAt) return;

  await prisma.$transaction(async (tx) => {
    await tx.authSession.update({
      where: { id: session.id },
      data: { revokedAt: now, revokedReason: 'signed_out' },
    });
    await authEvent(session.user, 'sign_out', { allowed: true, rule: 'session', reason: 'signed_out' }, tx);
  });
}

/**
 * Compare two tokens without leaking which byte differed.
 *
 * Exported for the webhook routes, which currently compare their shared secret
 * with `!==`. Not wired in here — that is a separate change to two files that
 * this phase does not touch.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export { stepAt };
