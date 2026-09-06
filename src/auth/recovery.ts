import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../db';
import type { Clock } from '../clock';
import { authEvent, guarded } from './guard';
import { hashPassword, passwordComplaint } from './password';
import { requiresSecondFactor, type Actor, type Role } from './permissions';
import { stepAt, verifyTotp } from './totp';

/**
 * Forgetting a password, and the thing a reset link is not allowed to be.
 *
 * A reset link is a second credential with the same power as the first,
 * delivered over email — so the question this module has to answer is not "how
 * does somebody get back in" but "what does a link prove". It proves control of
 * a mailbox. That is one factor, and it is the weakest one in the building.
 *
 * The previous phase bought a specific property, written on `User.totpSecret`:
 * a clinical account is never reachable with one factor. A reset flow that
 * takes a link and hands back a working session would undo that quietly,
 * through the one door nobody re-reads — mailbox access would become clinical
 * access, and every argument in the sign-in would still be true and no longer
 * matter.
 *
 * So the link is never sufficient on its own for a role that needs a second
 * factor. It gets you to the same challenge the sign-in gets you to, and the
 * code has to be right. `resolveReset` returns no `Actor` in any variant, for
 * the same reason `resolveSession` only returns one from `ready`: the
 * guarantee is a type rather than a check somebody remembers to write.
 *
 * The third case is the sharp one. A clinical account that has *never enrolled*
 * has no second factor to demand, so a link to it would be a complete takeover
 * on mailbox access alone — and worse than the sign-in equivalent, because the
 * attacker would then enrol their own authenticator against somebody else's
 * account. Those resets are refused outright and go to `clearSecondFactor`,
 * which is a person verifying a person.
 */

/** How long a link in a mailbox stays live. Deliberately short. */
export const RESET_TTL_MS = 30 * 60_000;

const TOKEN_BYTES = 32;

/** The token is a bearer credential; only its digest is ever written down. */
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * What a reset link may do for this account, before anything is looked up.
 *
 * Pure, so the whole table is assertable across every role in a millisecond —
 * and the table is the point, because the interesting cells are the two that
 * are not "let them in".
 *
 * `refused` is not a failure state to recover from in the flow. It is the
 * answer, and the recovery for it is a phone call to somebody who can verify a
 * person, which is what `clearSecondFactor` exists to be the end of.
 */
export type ResetStage = 'second_factor' | 'set_password' | 'refused';

export function resetStage(user: { role: Role; enrolled: boolean }): ResetStage {
  // Front desk and the auditor reach no clinical content, and have no second
  // factor to prove. The link is the whole of what is available to demand, and
  // demanding a factor nobody holds would just be a locked door.
  if (!requiresSecondFactor(user.role)) return 'set_password';
  // Enrolled: the link gets you as far as the challenge and no further. Exactly
  // where a correct password gets you.
  if (user.enrolled) return 'second_factor';
  // Nothing to prove, and everything to lose. See the header.
  return 'refused';
}

export interface Deps {
  clock: Clock;
}

interface ResetUser {
  id: string;
  name: string;
  role: Role;
  email: string;
}

/**
 * A reset in progress. No variant carries an `Actor`, and there is no `ready`.
 *
 * Completing a reset does not sign anybody in — it sets a password and ends
 * every session the account had. The person then signs in through the front
 * door like anybody else, which is the only ordering where the new password is
 * actually used to prove something.
 */
export type ResolvedReset =
  | { stage: 'second_factor'; resetId: string; user: ResetUser }
  | { stage: 'set_password'; resetId: string; user: ResetUser };

const RESET_USER_FIELDS = { id: true, name: true, role: true, email: true } as const;

/**
 * Somebody asked for a link.
 *
 * Returns nothing, always, whatever happened. An address with no account, a
 * deactivated account and a clinical account that never enrolled all produce
 * the identical silence and the identical screen — because a reset form that
 * answers "no such account" is the staff-list oracle the sign-in already went
 * to some trouble to close, reopened on a page with no rate limit and no
 * password to type.
 *
 * A new request supersedes any outstanding one. Two live links to one account
 * is two chances for the older one to still be sitting in a mailbox.
 */
export async function requestPasswordReset(
  email: string,
  { clock, baseUrl, mailer }: Deps & { baseUrl: string; mailer: ResetMailer },
): Promise<void> {
  const now = clock.now();
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: 'insensitive' }, active: true },
    select: { ...RESET_USER_FIELDS, totpSecret: true },
  });
  if (!user) return;

  const subject = { id: user.id, role: user.role };
  const stage = resetStage({ role: user.role, enrolled: !!user.totpSecret });

  if (stage === 'refused') {
    // Logged as a refusal rather than dropped, because this is the case an
    // administrator has to act on: somebody cannot get back in and the system
    // is deliberately not going to help them. A silent no-op would leave the
    // practice with a person who "never got the email".
    await authEvent(subject, 'reset_request', {
      allowed: false, rule: 'second_factor', reason: 'not_enrolled',
    });
    return;
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await prisma.$transaction(async (tx) => {
    await tx.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'superseded' },
    });
    await tx.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: digest(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + RESET_TTL_MS),
      },
    });
    await authEvent(subject, 'reset_request', {
      allowed: true, rule: 'password', reason: stage,
    }, tx);
  });

  // Outside the transaction on purpose: a mailer that throws must not roll back
  // the supersede, or a failed send would leave the *previous* link live.
  await mailer.send({ email: user.email, name: user.name }, `${baseUrl}/reset/${token}`);
}

/**
 * Load the reset a token names, or `null` if it is not usable.
 *
 * Not usable covers: unknown, expired, already spent, superseded by a newer
 * request, and an account deactivated since the link was sent. All of them are
 * one `null` — a page that distinguishes "expired" from "never existed" is the
 * same oracle in a smaller window.
 *
 * Does **not** advance anything. A reset link is not a session and re-reading
 * it must not extend its life.
 */
export async function resolveReset(token: string, { clock }: Deps): Promise<ResolvedReset | null> {
  if (!token) return null;
  const now = clock.now();

  const reset = await prisma.passwordReset.findUnique({
    where: { tokenHash: digest(token) },
    select: {
      id: true, expiresAt: true, usedAt: true, revokedAt: true, secondFactorAt: true,
      user: { select: { ...RESET_USER_FIELDS, active: true, totpSecret: true } },
    },
  });
  if (!reset) return null;
  if (reset.usedAt || reset.revokedAt) return null;
  if (reset.expiresAt <= now) return null;
  if (!reset.user.active) return null;

  const { active: _active, totpSecret, ...user } = reset.user;
  const stage = resetStage({ role: user.role, enrolled: !!totpSecret });
  // An account that enrolled *after* the link was sent now has a factor to
  // prove, and one that had its factor cleared by an administrator no longer
  // does — in which case the link is refused rather than promoted, because the
  // administrator clearing it is the recovery, not this.
  if (stage === 'refused') return null;
  if (stage === 'set_password' || reset.secondFactorAt) {
    return { stage: 'set_password', resetId: reset.id, user };
  }
  return { stage: 'second_factor', resetId: reset.id, user };
}

export type ResetFactorResult =
  | { ok: true }
  | { ok: false; reason: 'mismatch' | 'replayed' | 'malformed' | 'not_enrolled' | 'no_reset' };

/**
 * Prove the second factor for a reset in progress.
 *
 * Replay protection is `User.totpLastStep`, the same column the sign-in
 * advances, and sharing it is the point rather than an economy: a code spent
 * signing in cannot then be spent resetting the password, and a code spent
 * resetting cannot be spent signing in. One authenticator, one code, one use,
 * whichever door it was used at.
 */
export async function submitResetSecondFactor(
  token: string,
  code: string,
  { clock }: Deps,
): Promise<ResetFactorResult> {
  const now = clock.now();
  const reset = await prisma.passwordReset.findUnique({
    where: { tokenHash: digest(token) },
    select: {
      id: true, expiresAt: true, usedAt: true, revokedAt: true,
      user: { select: { id: true, role: true, active: true, totpSecret: true, totpLastStep: true } },
    },
  });
  if (!reset || reset.usedAt || reset.revokedAt || reset.expiresAt <= now || !reset.user.active) {
    return { ok: false, reason: 'no_reset' };
  }

  const { user } = reset;
  const subject = { id: user.id, role: user.role };
  if (!user.totpSecret) {
    await authEvent(subject, 'reset_second_factor', {
      allowed: false, rule: 'second_factor', reason: 'not_enrolled',
    });
    return { ok: false, reason: 'not_enrolled' };
  }

  const result = verifyTotp({
    secret: user.totpSecret,
    code,
    at: now,
    afterStep: user.totpLastStep === null ? undefined : Number(user.totpLastStep),
  });
  if (!result.ok) {
    await authEvent(subject, 'reset_second_factor', {
      allowed: false, rule: 'second_factor', reason: result.reason,
    });
    return { ok: false, reason: result.reason };
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { totpLastStep: BigInt(result.step) } });
    await tx.passwordReset.update({ where: { id: reset.id }, data: { secondFactorAt: now } });
    await authEvent(subject, 'reset_second_factor', {
      allowed: true, rule: 'second_factor', reason: 'verified',
    }, tx);
  });
  return { ok: true };
}

export type CompleteResult =
  | { ok: true }
  | { ok: false; reason: 'no_reset' }
  | { ok: false; reason: 'second_factor_required' }
  | { ok: false; reason: 'weak'; complaint: string };

/**
 * Set the new password, and end everything the old one had open.
 *
 * Three things happen together or not at all: the password changes, every live
 * session for the account is revoked, and the link is spent. The revocation is
 * what makes a reset a *remedy* — if the reason somebody is resetting is that
 * another person has their password, leaving that person's session running for
 * twelve hours means the reset did nothing for twelve hours.
 *
 * The lockout is cleared in the same write. A reset link is not a password
 * guess, so throttling it buys nothing; refusing it during a lockout would hand
 * anybody who knows a clinician's address a way to close both doors at once by
 * typing wrong passwords at the first one.
 */
export async function completeReset(
  token: string,
  plain: string,
  { clock }: Deps,
): Promise<CompleteResult> {
  const now = clock.now();
  const resolved = await resolveReset(token, { clock });
  if (!resolved) return { ok: false, reason: 'no_reset' };
  if (resolved.stage !== 'set_password') return { ok: false, reason: 'second_factor_required' };

  const complaint = passwordComplaint(plain);
  if (complaint) return { ok: false, reason: 'weak', complaint };

  const passwordHash = await hashPassword(plain);
  const subject = { id: resolved.user.id, role: resolved.user.role };

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: resolved.user.id },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    await tx.authSession.updateMany({
      where: { userId: resolved.user.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'password_changed' },
    });
    await tx.passwordReset.update({ where: { id: resolved.resetId }, data: { usedAt: now } });
    await authEvent(subject, 'reset_complete', { allowed: true, rule: 'password' }, tx);
  });
  return { ok: true };
}

/**
 * The other half, and the one this phase is not shippable without.
 *
 * Requiring the second factor to reset a password means somebody who loses
 * their password *and* their authenticator can no longer get back in by any
 * route the system offers. That is the correct security answer and an
 * unacceptable operational one on its own, so there has to be a path, and the
 * path has to be a person verifying a person.
 *
 * Three things about its shape are deliberate:
 *
 *   1. **It clears rather than reveals.** An administrator never sees a secret
 *      and never sets one. The account drops back to `enrol_second_factor`, and
 *      the *owner* enrols their own authenticator on their next sign-in, which
 *      is the only version where the person holding the factor is the person
 *      the factor is for.
 *   2. **It ends their sessions.** Whatever prompted this — a lost phone, a
 *      stolen one — a live session opened with the old factor is the thing the
 *      clearance is supposed to be closing.
 *   3. **It is audited as itself.** `admin` is already the most valuable
 *      credential in the building, and this widens it: one role can now put any
 *      clinical account back to a state where the next person to sign in
 *      chooses the second factor. That concentration is real and not
 *      designed away — what is available instead is that every use of it is one
 *      row, naming who, naming whom, and never quiet.
 */
export async function clearSecondFactor(
  actor: Actor,
  userId: string,
  { clock }: Deps,
): Promise<void> {
  const now = clock.now();
  await guarded(
    { actor, action: 'update', resource: 'user', resourceId: userId, reason: 'second_factor_cleared' },
    async (tx) => {
      await tx.user.update({
        where: { id: userId },
        // `totpLastStep` goes too. It belongs to a secret that no longer
        // exists, and leaving it would refuse the first code from the new
        // authenticator if it happened to land on a lower step.
        data: { totpSecret: null, totpEnrolledAt: null, totpLastStep: null },
      });
      await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'second_factor_cleared' },
      });
      // Any link already in flight for this account is now a link with nothing
      // to prove. `resolveReset` would refuse it anyway; spending it here says
      // so in the table rather than only in the branch.
      await tx.passwordReset.updateMany({
        where: { userId, usedAt: null, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'second_factor_cleared' },
      });
    },
  );
}

/**
 * Where a reset link goes.
 *
 * An interface rather than a function, for the same reason `Carrier` is one:
 * the policy above must not be able to depend on anything a real mail provider
 * happens to offer. It is also why nothing here touches `OutboxMessage`.
 * That table stores `body`, so putting a link through it would write a live
 * credential into a database column several read paths already reach — the
 * same class of mistake hard rule 10 exists to prevent, arrived at from the
 * side nobody guards.
 */
export interface ResetMailer {
  send(to: { email: string; name: string }, link: string): Promise<void>;
}
