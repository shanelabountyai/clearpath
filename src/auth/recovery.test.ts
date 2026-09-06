import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { fixedClock } from '../clock';
import { actor, makeUser, resetDb } from '../test/harness';
import { TOTP_PERIOD_SECONDS, codeForStep, stepAt } from './totp';
import { ROLES, requiresSecondFactor, type Role } from './permissions';
import { Forbidden } from '../errors';
import { devMailer, latestResetLink } from './mailer';
import {
  RESET_TTL_MS,
  clearSecondFactor,
  completeReset,
  requestPasswordReset,
  resetStage,
  resolveReset,
  submitResetSecondFactor,
  type ResetMailer,
} from './recovery';
import {
  beginEnrolment,
  confirmEnrolment,
  resolveSession,
  setPassword,
  signIn,
  submitSecondFactor,
} from './sessions';

const PASSWORD = 'a-long-enough-passphrase';
const NEW_PASSWORD = 'a-different-long-passphrase';
const AT = '2026-03-01T09:00:00Z';
const BASE = 'http://localhost:3700';

/**
 * The whole policy, decided before anything persists.
 *
 * Three answers across seven roles, and the two that are not "let them in" are
 * the ones worth the table. `set_password` is the ordinary case for a role with
 * no factor to prove; `second_factor` is a link that has got you exactly as far
 * as a correct password would; `refused` is the case a link cannot be made safe
 * for at all.
 */
describe('what a reset link may do (pure)', () => {
  it('lets a role with no second factor through on the link alone', () => {
    for (const role of ROLES.filter((r) => !requiresSecondFactor(r))) {
      expect(resetStage({ role, enrolled: false }), role).toBe('set_password');
      expect(resetStage({ role, enrolled: true }), role).toBe('set_password');
    }
  });

  it('sends an enrolled clinical role to the same challenge the sign-in does', () => {
    for (const role of ROLES.filter(requiresSecondFactor)) {
      expect(resetStage({ role, enrolled: true }), role).toBe('second_factor');
    }
  });

  /**
   * The sharp cell, and the reason this is a table rather than an `if`.
   *
   * A clinical account that never enrolled has no second factor to demand, so a
   * link to it would be a complete takeover on mailbox access alone — and worse
   * than the sign-in equivalent, because the attacker would then enrol their
   * own authenticator against somebody else's account and hold the factor from
   * then on. There is nothing this flow can ask that would make that safe.
   */
  it('refuses outright where there is no factor to prove and everything to lose', () => {
    for (const role of ROLES.filter(requiresSecondFactor)) {
      expect(resetStage({ role, enrolled: false }), role).toBe('refused');
    }
  });

  it('never returns an answer outside the three', () => {
    for (const role of ROLES) {
      for (const enrolled of [true, false]) {
        expect(['second_factor', 'set_password', 'refused'])
          .toContain(resetStage({ role, enrolled }));
      }
    }
  });
});

describe('against the database', () => {
  let clock = fixedClock(AT);
  let mailDir = '';
  let mailer: ResetMailer;
  const deps = () => ({ clock });
  const sendDeps = () => ({ clock, baseUrl: BASE, mailer });

  beforeEach(async () => {
    await resetDb();
    clock = fixedClock(AT);
    mailDir = mkdtempSync(join(tmpdir(), 'clearpath-mail-'));
    mailer = devMailer(mailDir);
  });
  afterEach(() => rmSync(mailDir, { recursive: true, force: true }));

  /** A staff account with a password, and — for a clinical role — a factor. */
  async function account(role: Role) {
    const user = await makeUser(role);
    await setPassword(user.id, PASSWORD, deps());
    if (requiresSecondFactor(role)) {
      const started = await signIn({ email: user.email, password: PASSWORD }, deps());
      if (!started.ok) throw new Error(started.reason);
      const { secret } = await beginEnrolment(started.token, deps());
      await confirmEnrolment(started.token, codeForStep(secret, stepAt(clock.now())), deps());
      // Enrolment *spends* a step — proving the secret works is itself a use of
      // a code, and the single-use rule does not make an exception for the
      // moment it was set up. Without this the fixture would hand every spec a
      // code the account had already spent, and the first three would fail
      // `replayed` on a system that was behaving correctly.
      clock.set(new Date(clock.now().getTime() + TOTP_PERIOD_SECONDS * 1000));
    }
    return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  }

  /** The token out of the link the mailer wrote, as a person would read it. */
  const linkFor = (email: string) => {
    const link = latestResetLink(email, mailDir);
    return link ? link.split('/').pop()! : null;
  };

  async function requested(role: Role) {
    const user = await account(role);
    await requestPasswordReset(user.email, sendDeps());
    return { user, token: linkFor(user.email) };
  }

  /** The code an authenticator would be showing right now for this account. */
  async function currentCode(userId: string) {
    const { totpSecret } = await prisma.user.findUniqueOrThrow({
      where: { id: userId }, select: { totpSecret: true },
    });
    return codeForStep(totpSecret!, stepAt(clock.now()));
  }

  // ── the link itself ──────────────────────────────────────────────────

  it('mails a link to an address that has an account', async () => {
    const { user, token } = await requested('front_desk');
    expect(token).toBeTruthy();
    expect(latestResetLink(user.email, mailDir)).toBe(`${BASE}/reset/${token}`);
  });

  /**
   * The enumeration oracle the sign-in already went to some trouble to close,
   * reopened on a page with no password to type and no attempt counter. It
   * must not answer.
   */
  it('says nothing at all about an address with no account', async () => {
    await expect(requestPasswordReset('nobody@example.test', sendDeps())).resolves.toBeUndefined();
    expect(readdirSync(mailDir)).toEqual([]);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it('sends nothing to a deactivated account, and says nothing about that either', async () => {
    const user = await account('front_desk');
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    await requestPasswordReset(user.email, sendDeps());
    expect(readdirSync(mailDir)).toEqual([]);
  });

  it('matches an address case-insensitively, as the sign-in does', async () => {
    const user = await account('front_desk');
    await requestPasswordReset(user.email.toUpperCase(), sendDeps());
    expect(linkFor(user.email)).toBeTruthy();
  });

  it('stores the digest of the token and never the token', async () => {
    const { token } = await requested('front_desk');
    const rows = await prisma.passwordReset.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('supersedes an outstanding link rather than leaving two live', async () => {
    const { user, token: first } = await requested('front_desk');
    await requestPasswordReset(user.email, sendDeps());
    const second = linkFor(user.email);

    expect(second).not.toBe(first);
    expect(await resolveReset(first!, deps())).toBeNull();
    expect(await resolveReset(second!, deps())).not.toBeNull();
    expect((await prisma.passwordReset.findFirst({ where: { revokedAt: { not: null } } }))!.revokedReason)
      .toBe('superseded');
  });

  it('expires, and re-reading it does not extend it', async () => {
    const { token } = await requested('front_desk');
    clock.set(new Date(new Date(AT).getTime() + RESET_TTL_MS - 1000));
    expect(await resolveReset(token!, deps())).not.toBeNull();
    clock.set(new Date(new Date(AT).getTime() + RESET_TTL_MS));
    expect(await resolveReset(token!, deps())).toBeNull();
  });

  it('refuses an unknown token in the same silence as an expired one', async () => {
    expect(await resolveReset('not-a-real-token', deps())).toBeNull();
    expect(await resolveReset('', deps())).toBeNull();
  });

  // ── the second factor ────────────────────────────────────────────────

  /**
   * The property this whole phase exists to keep. Mailbox access is one factor
   * and the weakest one in the building; it must not become clinical access.
   */
  it('will not set a clinical password on the strength of the link alone', async () => {
    const { token } = await requested('therapist');
    expect((await resolveReset(token!, deps()))!.stage).toBe('second_factor');
    expect(await completeReset(token!, NEW_PASSWORD, deps()))
      .toEqual({ ok: false, reason: 'second_factor_required' });
  });

  it('sets it once the code is right', async () => {
    const { user, token } = await requested('therapist');
    expect(await submitResetSecondFactor(token!, await currentCode(user.id), deps())).toEqual({ ok: true });
    expect((await resolveReset(token!, deps()))!.stage).toBe('set_password');
    expect(await completeReset(token!, NEW_PASSWORD, deps())).toEqual({ ok: true });

    const after = await signIn({ email: user.email, password: NEW_PASSWORD }, deps());
    expect(after.ok).toBe(true);
  });

  it('refuses a wrong code and does not advance the reset', async () => {
    const { token } = await requested('therapist');
    expect(await submitResetSecondFactor(token!, '000000', deps()))
      .toEqual({ ok: false, reason: 'mismatch' });
    expect((await resolveReset(token!, deps()))!.stage).toBe('second_factor');
  });

  /**
   * One authenticator, one code, one use — whichever door it was used at.
   *
   * `totpLastStep` lives on the account rather than on the session or the
   * reset, so a code spent signing in cannot then be spent resetting the
   * password. Sharing that column across the two flows is the point rather than
   * an economy: a phished code is worth one action, not one action per door.
   */
  it('refuses a code already spent at the sign-in', async () => {
    const { user, token } = await requested('therapist');
    const code = await currentCode(user.id);

    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error(started.reason);
    expect(await submitSecondFactor(started.token, code, deps())).toEqual({ ok: true });

    expect(await submitResetSecondFactor(token!, code, deps()))
      .toEqual({ ok: false, reason: 'replayed' });
  });

  it('and refuses at the sign-in a code already spent resetting', async () => {
    const { user, token } = await requested('therapist');
    const code = await currentCode(user.id);
    expect(await submitResetSecondFactor(token!, code, deps())).toEqual({ ok: true });

    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error(started.reason);
    expect(await submitSecondFactor(started.token, code, deps()))
      .toEqual({ ok: false, reason: 'replayed' });
  });

  it('front desk needs no code, because there is none to need', async () => {
    const { user, token } = await requested('front_desk');
    expect((await resolveReset(token!, deps()))!.stage).toBe('set_password');
    expect(await completeReset(token!, NEW_PASSWORD, deps())).toEqual({ ok: true });
    expect((await signIn({ email: user.email, password: NEW_PASSWORD }, deps())).ok).toBe(true);
  });

  /**
   * The refusal, end to end. A clinical account that never enrolled gets no
   * link, and the person sees the same screen everybody else sees — the way
   * back in for them is a person verifying a person.
   */
  it('sends no link at all to a clinical account that never enrolled', async () => {
    const user = await makeUser('therapist');
    await setPassword(user.id, PASSWORD, deps());
    await requestPasswordReset(user.email, sendDeps());

    expect(readdirSync(mailDir)).toEqual([]);
    expect(await prisma.passwordReset.count()).toBe(0);
    // Logged as a refusal, because somebody now cannot get back in and an
    // administrator is the only remedy. A silent no-op would leave the practice
    // with a person who "never got the email".
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'reset_request' } });
    expect(row).toMatchObject({ allowed: false, reason: 'not_enrolled', resourceId: user.id });
  });

  /**
   * The window between the link being sent and it being used is a window in
   * which the account's enrolment can change, in both directions.
   */
  it('demands a factor enrolled after the link was sent', async () => {
    const user = await makeUser('front_desk');
    await setPassword(user.id, PASSWORD, deps());
    await requestPasswordReset(user.email, sendDeps());
    const token = linkFor(user.email)!;
    await prisma.user.update({ where: { id: user.id }, data: { role: 'therapist' } });

    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error(started.reason);
    const { secret } = await beginEnrolment(started.token, deps());
    await confirmEnrolment(started.token, codeForStep(secret, stepAt(clock.now())), deps());

    expect((await resolveReset(token, deps()))!.stage).toBe('second_factor');
  });

  it('refuses a link whose factor an administrator has since cleared', async () => {
    const { user, token } = await requested('supervisor');
    await clearSecondFactor(actor(await makeUser('admin')), user.id, deps());
    expect(await resolveReset(token!, deps())).toBeNull();
  });

  // ── completing it ────────────────────────────────────────────────────

  it('spends the link, so it works exactly once', async () => {
    const { token } = await requested('front_desk');
    expect(await completeReset(token!, NEW_PASSWORD, deps())).toEqual({ ok: true });
    expect(await resolveReset(token!, deps())).toBeNull();
    expect(await completeReset(token!, 'a-third-long-passphrase', deps()))
      .toEqual({ ok: false, reason: 'no_reset' });
  });

  it('holds the new password to the same bar as any other', async () => {
    const { token } = await requested('front_desk');
    const result = await completeReset(token!, 'short', deps());
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'weak' });
    // And the link is not spent by a rejected attempt.
    expect(await resolveReset(token!, deps())).not.toBeNull();
  });

  /**
   * What makes a reset a remedy rather than a formality. If the reason somebody
   * is resetting is that another person has their password, leaving that
   * person's session running until it times out means the reset did nothing for
   * twelve hours.
   */
  it('ends every session the old password had open', async () => {
    const { user, token } = await requested('front_desk');
    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error(started.reason);
    expect(await resolveSession(started.token, deps())).not.toBeNull();

    await completeReset(token!, NEW_PASSWORD, deps());

    expect(await resolveSession(started.token, deps())).toBeNull();
    expect((await prisma.authSession.findFirstOrThrow()).revokedReason).toBe('password_changed');
  });

  it('signs nobody in — completing a reset yields no session and no actor', async () => {
    const { token } = await requested('front_desk');
    const result = await completeReset(token!, NEW_PASSWORD, deps());
    expect(result).toEqual({ ok: true });
    expect(await prisma.authSession.count({ where: { revokedAt: null } })).toBe(0);
  });

  /**
   * A reset link is not a password guess, so throttling it buys nothing.
   * Refusing it during a lockout would hand anybody who knows a clinician's
   * address a way to close both doors at once by typing wrong passwords at the
   * first one — an availability attack on a working clinical account, requiring
   * nothing but the address.
   */
  it('works while the account is locked out, and clears the lock', async () => {
    const user = await account('front_desk');
    for (let i = 0; i < 6; i++) {
      await signIn({ email: user.email, password: 'wrong-password-here' }, deps());
    }
    expect((await signIn({ email: user.email, password: PASSWORD }, deps())).ok).toBe(false);

    await requestPasswordReset(user.email, sendDeps());
    expect(await completeReset(linkFor(user.email)!, NEW_PASSWORD, deps())).toEqual({ ok: true });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.lockedUntil).toBeNull();
    expect(after.failedLoginCount).toBe(0);
    expect((await signIn({ email: user.email, password: NEW_PASSWORD }, deps())).ok).toBe(true);
  });

  it('leaves a trail of three events and no fourth', async () => {
    const { user, token } = await requested('therapist');
    await submitResetSecondFactor(token!, await currentCode(user.id), deps());
    await completeReset(token!, NEW_PASSWORD, deps());

    const trail = (await prisma.auditEvent.findMany({
      where: { actorId: user.id, action: { startsWith: 'reset_' } },
      orderBy: { at: 'asc' },
    })).map((r) => r.action);
    expect(trail).toEqual(['reset_request', 'reset_second_factor', 'reset_complete']);
  });

  it('carries no address and no typed string into the trail', async () => {
    const { user, token } = await requested('therapist');
    await submitResetSecondFactor(token!, '000000', deps());
    await completeReset(token!, NEW_PASSWORD, deps());

    const rows = await prisma.auditEvent.findMany({ where: { actorId: user.id } });
    const text = JSON.stringify(rows);
    for (const secret of [user.email, PASSWORD, NEW_PASSWORD, token!]) {
      expect(text).not.toContain(secret);
    }
  });

  // ── the administrator's path ─────────────────────────────────────────

  /**
   * Requiring the second factor to reset a password means somebody who loses
   * their password *and* their authenticator cannot get back in by any route
   * the system offers. That is the correct security answer and an unacceptable
   * operational one on its own, so the other half is a person verifying a
   * person — and what that person does is *clear*, never see and never set.
   */
  it('clears a lost factor rather than revealing or replacing one', async () => {
    const boss = await makeUser('admin');
    const user = await account('therapist');
    expect(user.totpSecret).toBeTruthy();

    await clearSecondFactor(actor(boss), user.id, deps());

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.totpSecret).toBeNull();
    expect(after.totpEnrolledAt).toBeNull();
    // The spent-step marker belongs to a secret that no longer exists; leaving
    // it would refuse the first code from the new authenticator.
    expect(after.totpLastStep).toBeNull();
  });

  it('puts the account back to mandatory enrolment, held by its owner', async () => {
    const boss = await makeUser('admin');
    const user = await account('therapist');
    await clearSecondFactor(actor(boss), user.id, deps());

    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error(started.reason);
    expect(started.stage).toBe('enrol_second_factor');
    expect((await resolveSession(started.token, deps()))!.stage).toBe('enrol_second_factor');
  });

  it('ends the sessions the old factor opened', async () => {
    const boss = await makeUser('admin');
    const user = await account('therapist');
    const started = await signIn({ email: user.email, password: PASSWORD }, deps());
    if (!started.ok) throw new Error(started.reason);
    await submitSecondFactor(started.token, await currentCode(user.id), deps());
    expect((await resolveSession(started.token, deps()))!.stage).toBe('ready');

    await clearSecondFactor(actor(boss), user.id, deps());
    expect(await resolveSession(started.token, deps())).toBeNull();
    expect((await prisma.authSession.findFirstOrThrow()).revokedReason).toBe('second_factor_cleared');
  });

  it('is one role only, and every refusal is on the record', async () => {
    const user = await account('therapist');
    for (const role of ROLES.filter((r) => r !== 'admin' && r !== 'client')) {
      const other = await makeUser(role);
      await expect(clearSecondFactor(actor(other), user.id, deps())).rejects.toThrow(Forbidden);
    }
    const denials = await prisma.auditEvent.findMany({
      where: { action: 'update', resource: 'user', allowed: false },
    });
    expect(denials).toHaveLength(ROLES.length - 2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpSecret).toBeTruthy();
  });

  it('names itself in the trail, because it is the widest thing admin can do', async () => {
    const boss = await makeUser('admin');
    const user = await account('therapist');
    await clearSecondFactor(actor(boss), user.id, deps());

    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { actorId: boss.id, resource: 'user', allowed: true },
    });
    expect(row).toMatchObject({ resourceId: user.id, reason: 'second_factor_cleared' });
  });
});

/**
 * The structural half. The specs above say the flow refuses what it should;
 * these say nothing was built beside it that goes around.
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
 * The reset table holds a bearer credential's digest and the state of a flow
 * that can set a password. A page that can read it can tell whether an address
 * has an account and how far along a reset is; a page that can write it can
 * mint one. It stays where the rest of the credentials are.
 */
it('nothing outside the auth module touches the reset table', () => {
  const offenders = sourceFiles((p) => p.startsWith('src/auth/')).filter((p) =>
    /\bpasswordReset\b/.test(readFileSync(p, 'utf8')),
  );
  expect(offenders).toEqual([]);
});

/**
 * The one that would undo the phase, written for the shortcut somebody reaches
 * for at 5pm: a reset that calls `setPassword` directly, or writes
 * `passwordHash` itself, skips `resolveReset` and with it the entire second
 * factor. `completeReset` is the only path, and it is the only path *because*
 * nothing else may write the column — which the credential lint already says
 * for every file outside `src/auth/`, and this says for the ones inside it.
 */
it('only the three files that do the proving can set a password', () => {
  // `hashPassword` is the chokepoint rather than the column name: `demo.ts`
  // names the column in a `where` clause and sets nothing, and a lint that
  // could not tell the two apart would be one somebody adds an exception to.
  //
  // `accounts.ts` joined the list when invitations landed, and widening a lint
  // is the moment to say what still holds rather than the moment to stop
  // looking. It writes a password only through `acceptInvitation`, which goes
  // through `resolveInvitation` first — and that refuses any account
  // `credentialRoute` does not answer `invite` for, which is every account
  // whose owner has ever set one. So it can set a *first* password and cannot
  // reach an established account at all, which is the property this lint is
  // protecting stated for a third door rather than an exception to it. The
  // behaviour is asserted directly in `accounts.test.ts`, under "refuses an
  // account whose owner has already set a password" and "stays shut after the
  // practice manager clears the second factor".
  const offenders = readdirSync('src/auth')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => !['sessions.ts', 'recovery.ts', 'password.ts', 'accounts.ts'].includes(f))
    .filter((f) => /\bhashPassword\s*\(/.test(readFileSync(`src/auth/${f}`, 'utf8')));
  expect(offenders).toEqual([]);
});

/**
 * And the guard on the guard: the third door is only safe because it asks
 * `credentialRoute` before it hashes anything, so a future edit that dropped
 * the resolver would leave a file that can set a password on any account.
 */
it('the invitation path asks which door the account gets before it sets one', () => {
  const src = readFileSync('src/auth/accounts.ts', 'utf8');
  expect(src).toContain('credentialRoute');
  expect(src.indexOf('resolveInvitation')).toBeLessThan(src.indexOf('hashPassword('));
});

/**
 * The link is the credential. `OutboxMessage` stores `body`, so a reset routed
 * through the outbox would write a live one into a table the confirmation
 * report, the work lists and the delivery job all read — the same class of
 * mistake hard rule 10 exists to prevent, arrived at from the side nobody
 * guards. The mailer is an interface with a filesystem driver for exactly that
 * reason, and this is what keeps somebody from "simplifying" it later.
 */
it('no reset link is ever handed to the outbox', () => {
  // An import rather than a mention, so the paragraph above this test that
  // explains *why* does not fail the test that enforces it.
  const offenders = readdirSync('src/auth')
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /\bfrom\s+'\.\.\/messaging\//.test(readFileSync(`src/auth/${f}`, 'utf8')));
  expect(offenders).toEqual([]);
});
