import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { fixedClock } from '../clock';
import { Conflict, Forbidden } from '../errors';
import { actor, makeUser, resetDb } from '../test/harness';
import { ROLES, requiresCoSignature, requiresSecondFactor, type Role } from './permissions';
import {
  INVITE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  accountComplaint,
  acceptInvitation,
  createAccount,
  credentialRoute,
  credentialRoutes,
  generateInviteCode,
  mayBeNamedSupervisor,
  supervisionRule,
  normalizeInviteCode,
  reissueInvitation,
  resolveInvitation,
  setAccountActive,
  type AccountInput,
} from './accounts';
import { clearSecondFactor, requestPasswordReset, resolveReset } from './recovery';
import { resolveSession, setPassword, signIn } from './sessions';
import { generateSecret } from './totp';

const AT = '2026-04-06T09:00:00Z';
const BASE = 'http://localhost:3700';
const PASSWORD = 'a-long-enough-passphrase';

const ok = (over: Partial<AccountInput> = {}): AccountInput => ({
  name: 'Rosa Delgado',
  email: 'rosa@example.test',
  role: 'front_desk',
  ...over,
});

const FREE = { emailTaken: false, supervisorRole: null } as const;

/**
 * The rule the whole module rests on, decided before anything persists.
 *
 * One line, two answers, and the security argument of the phase: an invitation
 * is issuable only to an account that has never had a password. An
 * administrator never sets one, so a password exists if and only if the
 * account's *owner* put it there — which makes this a statement about the
 * account having been claimed rather than about anybody's login history.
 */
describe('which door an account gets (pure)', () => {
  it('offers an invitation to an account nobody has claimed', () => {
    expect(credentialRoute({ hasPassword: false })).toBe('invite');
  });

  it('offers a reset once its owner has set a password, for every role alike', () => {
    expect(credentialRoute({ hasPassword: true })).toBe('reset');
  });
});

describe('the code that travels by the other channel (pure)', () => {
  it('avoids the characters a person mishears down a phone line', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateInviteCode()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, generateInviteCode));
    expect(seen.size).toBe(500);
  });

  /**
   * Case, spaces and the hyphen are presentation. Somebody copying a code off a
   * sticky note types it lowercase and without the dash about half the time,
   * and refusing the right answer badly would spend one of five attempts.
   */
  it('reads what somebody meant rather than what they typed', () => {
    const code = 'A1B2-C3D4';
    for (const typed of ['a1b2-c3d4', 'A1B2C3D4', ' a1b2 c3d4 ', 'A1b2-C3d4']) {
      expect(normalizeInviteCode(typed)).toBe(normalizeInviteCode(code));
    }
  });

  it('does not fold two different codes together', () => {
    expect(normalizeInviteCode('A1B2-C3D4')).not.toBe(normalizeInviteCode('A1B2-C3D5'));
  });
});

/**
 * Validation as a sentence, and one rule that is not house style.
 *
 * The associate cell is the one worth the table: `requiresCoSignature` says an
 * associate's progress note is not a complete record until their supervisor
 * countersigns, and `signProgressNote` refuses with `no_supervisor` when there
 * is nobody to route it to. That refusal lands after a session has happened and
 * a note has been drafted. Checking it here moves the identical failure to the
 * one moment it costs nothing.
 */
describe('what a new account has to have (pure)', () => {
  it('accepts an ordinary account', () => {
    expect(accountComplaint(ok(), FREE)).toBeNull();
  });

  it('wants a name, because it is what appears on their notes', () => {
    expect(accountComplaint(ok({ name: '  ' }), FREE)).toMatch(/name/i);
    expect(accountComplaint(ok({ name: 'X' }), FREE)).toMatch(/name/i);
  });

  it('wants something shaped like an address, because that is where the link goes', () => {
    for (const email of ['rosa', 'rosa@', '@example.test', 'rosa@example', 'a b@c.test']) {
      expect(accountComplaint(ok({ email }), FREE), email).toMatch(/email address/i);
    }
  });

  it('refuses an address somebody already holds', () => {
    expect(accountComplaint(ok(), { ...FREE, emailTaken: true })).toMatch(/already has that address/i);
  });

  /**
   * `client` exists so a form submitted through a tokenized link has an honest
   * actor in the audit trail. Nobody signs in as one, so an account with that
   * role would be a door with no room behind it.
   */
  it('refuses the client role, which is not an account anybody signs in to', () => {
    expect(accountComplaint(ok({ role: 'client' }), FREE)).toMatch(/Clients do not have accounts/i);
  });

  it('insists an associate has a supervisor, before the note rather than after it', () => {
    const complaint = accountComplaint(ok({ role: 'associate' }), FREE);
    expect(complaint).toMatch(/needs a supervisor/i);
    expect(complaint).toMatch(/never completed/i);
  });

  it('lets an associate through once one is named', () => {
    expect(accountComplaint(
      ok({ role: 'associate', supervisorId: 'sup-1' }),
      { emailTaken: false, supervisorRole: 'supervisor' },
    )).toBeNull();
  });

  it('asks nobody else for a supervisor', () => {
    for (const role of ROLES.filter((r) => r !== 'associate' && r !== 'client')) {
      expect(accountComplaint(ok({ role }), FREE), role).toBeNull();
    }
  });

  it('refuses a supervisor who does not hold the role', () => {
    for (const supervisorRole of ROLES.filter((r) => r !== 'supervisor')) {
      expect(accountComplaint(
        ok({ role: 'therapist', supervisorId: 'sup-1' }),
        { emailTaken: false, supervisorRole },
      ), supervisorRole).toMatch(/does not hold the supervisor role/i);
    }
  });

  it('refuses to supervise the roles supervision means nothing for', () => {
    for (const role of ['front_desk', 'admin', 'auditor'] as Role[]) {
      expect(accountComplaint(
        ok({ role, supervisorId: 'sup-1' }),
        { emailTaken: false, supervisorRole: 'supervisor' },
      ), role).toMatch(/Only clinicians are supervised/i);
    }
  });
});

/**
 * The same rules again, as the values a form is built out of.
 *
 * These exist so the "add someone" screen can enable and require the supervisor
 * field without branching on a role itself — hard rule 1 says no component
 * draws its own conclusion from one, and "which control is greyed out" is
 * exactly where that erodes first. What matters is that they agree with
 * `accountComplaint`, which is what these assert.
 */
describe('supervision, as the form has to see it (pure)', () => {
  it('requires one for an associate and nobody else', () => {
    for (const role of ROLES) {
      expect(supervisionRule(role) === 'required', role).toBe(requiresCoSignature(role));
    }
  });

  it('offers one to the clinical roles and withholds it from the rest', () => {
    expect(ROLES.filter((r) => supervisionRule(r) !== 'none'))
      .toEqual(['therapist', 'associate', 'supervisor']);
  });

  it('names only supervisors as possible supervisors', () => {
    expect(ROLES.filter(mayBeNamedSupervisor)).toEqual(['supervisor']);
  });

  /**
   * The form and the validation are the same rule or they are two rules. Every
   * cell here is the screen's answer checked against the server's.
   */
  it('agrees with what the validation would refuse', () => {
    for (const role of ROLES.filter((r) => r !== 'client')) {
      const rule = supervisionRule(role);
      const withNobody = accountComplaint(ok({ role }), FREE);
      expect(withNobody === null, `${role} with nobody`).toBe(rule !== 'required');

      const withOne = accountComplaint(
        ok({ role, supervisorId: 'sup-1' }),
        { emailTaken: false, supervisorRole: 'supervisor' },
      );
      expect(withOne === null, `${role} with a supervisor`).toBe(rule !== 'none');
    }
  });
});

describe('creating an account', () => {
  let clock: ReturnType<typeof fixedClock>;
  let boss: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    clock = fixedClock(AT);
    boss = await makeUser('admin');
  });

  const deps = () => ({ clock, baseUrl: BASE });
  const admin = () => actor(boss);

  it('creates the row and hands back both halves of the way in', async () => {
    const invitation = await createAccount(admin(), ok({ role: 'therapist' }), deps());

    expect(invitation.link).toContain(`${BASE}/invite/`);
    expect(invitation.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(invitation.expiresAt.getTime()).toBe(new Date(AT).getTime() + INVITE_TTL_MS);

    const user = await prisma.user.findUnique({ where: { id: invitation.userId } });
    expect(user).toMatchObject({ name: 'Rosa Delgado', email: 'rosa@example.test', role: 'therapist', active: true });
  });

  /**
   * The composition this module exists to refuse.
   *
   * An administrator who could set a password would, combined with
   * `clearSecondFactor` — which they already hold — be an administrator who
   * could sign in as any clinician in the building, and every audit row from
   * that session would name the clinician. There is no argument here, only the
   * absence of a field, so the assertion is on the absence.
   */
  it('leaves the account with no password, because nothing here can give it one', async () => {
    const invitation = await createAccount(admin(), ok({ role: 'therapist' }), deps());
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: invitation.userId },
      select: { passwordHash: true, totpSecret: true },
    });
    expect(row.passwordHash).toBeNull();
    expect(row.totpSecret).toBeNull();

    // And it cannot be signed in to with anything, including the code.
    expect(await signIn({ email: 'rosa@example.test', password: invitation.code }, { clock }))
      .toEqual({ ok: false, reason: 'rejected' });
  });

  it('stores only digests of both halves', async () => {
    const invitation = await createAccount(admin(), ok(), deps());
    const row = await prisma.invitation.findFirstOrThrow({ where: { userId: invitation.userId } });
    const token = invitation.link.split('/').pop()!;
    expect(row.tokenHash).not.toBe(token);
    expect(row.codeHash).not.toContain(normalizeInviteCode(invitation.code));
    expect(row.attempts).toBe(0);
  });

  it('names the account and the role granted in the audit trail', async () => {
    const invitation = await createAccount(admin(), ok({ role: 'supervisor' }), deps());
    const rows = await prisma.auditEvent.findMany({ where: { resourceId: invitation.userId } });

    expect(rows).toContainEqual(expect.objectContaining({
      actorId: boss.id, action: 'create', resource: 'user', allowed: true, reason: 'role:supervisor',
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      actorId: invitation.userId, action: 'invite_issued', allowed: true, reason: 'created',
    }));
  });

  it('is refused to every role but the practice manager, and the refusal is logged', async () => {
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      const other = await makeUser(role);
      await expect(createAccount(actor(other), ok({ email: `x-${role}@example.test` }), deps()))
        .rejects.toBeInstanceOf(Forbidden);
      expect(await prisma.auditEvent.count({
        where: { actorId: other.id, action: 'create', resource: 'user', allowed: false },
      }), role).toBe(1);
      expect(await prisma.user.findFirst({ where: { email: `x-${role}@example.test` } })).toBeNull();
    }
  });

  it('refuses an invalid account before it writes anything', async () => {
    await expect(createAccount(admin(), ok({ role: 'associate' }), deps()))
      .rejects.toThrow(Conflict);
    expect(await prisma.user.count({ where: { email: 'rosa@example.test' } })).toBe(0);
  });

  it('refuses an address another account already holds, whatever its case', async () => {
    await createAccount(admin(), ok(), deps());
    await expect(createAccount(admin(), ok({ name: 'Someone Else', email: 'ROSA@example.test' }), deps()))
      .rejects.toThrow(/already has that address/i);
  });

  /**
   * And the refusal a role gets does not depend on the state of the data.
   *
   * A caller the matrix would refuse must not be answered by the *domain*
   * instead — "somebody already has that address" is a fact about the staff
   * list, and a screen nobody may reach should not be handing it out through
   * its error path. The denial row is the other half: a probe nobody logged is
   * a probe nobody can find afterwards.
   */
  it('refuses the wrong role before it looks at the address', async () => {
    await createAccount(admin(), ok(), deps());
    const other = await makeUser('therapist');

    await expect(createAccount(actor(other), ok({ name: 'Someone Else' }), deps()))
      .rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.auditEvent.count({
      where: { actorId: other.id, action: 'create', resource: 'user', allowed: false },
    })).toBe(1);
  });

  /**
   * The screen has to draw a different button for a claimed row than for an
   * unclaimed one, and it cannot select `passwordHash` to find out — that name
   * does not appear outside this module, which is what stops a page from
   * putting a credential in its own HTML. So the conclusion crosses the
   * boundary and the column does not.
   */
  it('answers which rows have been claimed, without handing over the column', async () => {
    const fresh = await createAccount(admin(), ok(), deps());
    const claimed = await createAccount(admin(), ok({ name: 'Ari Vance', email: 'ari@example.test' }), deps());
    await acceptInvitation(claimed.link.split('/').pop()!, claimed.code, 'a-long-enough-passphrase', { clock });

    expect(await credentialRoutes([fresh.userId, claimed.userId, boss.id])).toEqual({
      [fresh.userId]: 'invite',
      [claimed.userId]: 'reset',
      [boss.id]: 'invite',
    });
    expect(await credentialRoutes([])).toEqual({});
  });

  it('resolves the supervisor from data rather than trusting the form', async () => {
    const notASupervisor = await makeUser('therapist');
    await expect(createAccount(
      admin(),
      ok({ role: 'associate', email: 'assoc@example.test', supervisorId: notASupervisor.id }),
      deps(),
    )).rejects.toThrow(/does not hold the supervisor role/i);
  });
});

describe('accepting an invitation', () => {
  let clock: ReturnType<typeof fixedClock>;
  let boss: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    clock = fixedClock(AT);
    boss = await makeUser('admin');
  });

  const deps = () => ({ clock, baseUrl: BASE });
  const tokenOf = (link: string) => link.split('/').pop()!;

  async function invite(over: Partial<AccountInput> = {}) {
    const invitation = await createAccount(actor(boss), ok(over), deps());
    return { ...invitation, token: tokenOf(invitation.link) };
  }

  it('shows the person who they are before asking for anything', async () => {
    const { token, userId } = await invite({ role: 'therapist' });
    expect(await resolveInvitation(token, { clock })).toEqual({
      invitationId: expect.any(String),
      user: { id: userId, name: 'Rosa Delgado', email: 'rosa@example.test', role: 'therapist' },
    });
  });

  it('claims the account when both halves are right', async () => {
    const { token, code, userId } = await invite();
    expect(await acceptInvitation(token, code, PASSWORD, { clock })).toEqual({ ok: true });

    expect(await signIn({ email: 'rosa@example.test', password: PASSWORD }, { clock }))
      .toMatchObject({ ok: true, stage: 'ready' });
    const row = await prisma.invitation.findFirstOrThrow({ where: { userId } });
    expect(row.acceptedAt).toEqual(new Date(AT));
  });

  it('takes the code however somebody types it', async () => {
    const { token, code } = await invite();
    const typed = code.toLowerCase().replace('-', ' ');
    expect(await acceptInvitation(token, typed, PASSWORD, { clock })).toEqual({ ok: true });
  });

  /**
   * The half this phase is built around. A link in a mailbox is one factor and
   * the weakest one in the building — the previous phase refused a *reset* on
   * exactly that basis for a clinical account with nothing else to prove, and a
   * brand new clinical account is precisely that shape. So the link alone
   * reaches the screen and gets no further.
   */
  it('refuses the link alone, which is the whole reason there are two halves', async () => {
    const { token } = await invite({ role: 'therapist' });
    const result = await acceptInvitation(token, 'ZZZZ-ZZZZ', PASSWORD, { clock });
    expect(result).toEqual({ ok: false, reason: 'wrong_code', attemptsLeft: MAX_CODE_ATTEMPTS - 1 });

    expect(await signIn({ email: 'rosa@example.test', password: PASSWORD }, { clock }))
      .toEqual({ ok: false, reason: 'rejected' });
  });

  it('burns the invitation rather than throttling it, after enough guesses', async () => {
    const { token, code, userId } = await invite();
    for (let i = 1; i <= MAX_CODE_ATTEMPTS; i += 1) {
      expect(await acceptInvitation(token, 'ZZZZ-ZZZZ', PASSWORD, { clock }))
        .toEqual({ ok: false, reason: 'wrong_code', attemptsLeft: MAX_CODE_ATTEMPTS - i });
    }
    // Even the right code is too late now.
    expect(await acceptInvitation(token, code, PASSWORD, { clock }))
      .toEqual({ ok: false, reason: 'no_invitation' });
    expect(await resolveInvitation(token, { clock })).toBeNull();
    expect((await prisma.invitation.findFirstOrThrow({ where: { userId } })).revokedReason)
      .toBe('code_attempts');
  });

  it('records the guessing as guessing', async () => {
    const { token, userId } = await invite();
    await acceptInvitation(token, 'ZZZZ-ZZZZ', PASSWORD, { clock });
    expect(await prisma.auditEvent.findFirst({
      where: { actorId: userId, action: 'invite_accepted', allowed: false },
    })).toMatchObject({ reason: 'wrong_code' });
  });

  /**
   * A weak password must not cost an attempt, and it must not be answered
   * before the code is proved — "your password is too short" from the link
   * alone is a reply the link alone should not be able to get.
   */
  it('checks the code before the password, and a weak one spends nothing', async () => {
    const { token, code } = await invite();
    expect(await acceptInvitation(token, code, 'short', { clock }))
      .toEqual({ ok: false, reason: 'weak', complaint: expect.stringMatching(/12 characters/) });
    expect((await prisma.invitation.findFirstOrThrow({})).attempts).toBe(0);
    expect(await acceptInvitation(token, code, PASSWORD, { clock })).toEqual({ ok: true });
  });

  it('works once', async () => {
    const { token, code } = await invite();
    await acceptInvitation(token, code, PASSWORD, { clock });
    expect(await acceptInvitation(token, code, PASSWORD, { clock }))
      .toEqual({ ok: false, reason: 'no_invitation' });
  });

  it('expires', async () => {
    const { token, code } = await invite();
    clock.advance(INVITE_TTL_MS);
    expect(await resolveInvitation(token, { clock })).toBeNull();
    expect(await acceptInvitation(token, code, PASSWORD, { clock }))
      .toEqual({ ok: false, reason: 'no_invitation' });
  });

  it('answers one null for a token that never existed', async () => {
    expect(await resolveInvitation('not-a-token', { clock })).toBeNull();
    expect(await resolveInvitation('', { clock })).toBeNull();
  });

  /**
   * Signing nobody in is the same decision `completeReset` makes, and here it
   * carries more: for a clinical role the front door is where mandatory
   * enrolment happens, so the second factor this flow never asked for is
   * demanded on the very next screen, before the account can reach anything.
   */
  it('signs nobody in, and sends a clinical account straight to enrolment', async () => {
    const { token, code } = await invite({ role: 'therapist' });
    await acceptInvitation(token, code, PASSWORD, { clock });

    const result = await signIn({ email: 'rosa@example.test', password: PASSWORD }, { clock });
    expect(result).toMatchObject({ ok: true, stage: 'enrol_second_factor' });
    if (!result.ok) throw new Error('unreachable');
    // Half-authenticated, and there is no actor to be had from it.
    expect(await resolveSession(result.token, { clock })).toMatchObject({ stage: 'enrol_second_factor' });
    expect(requiresSecondFactor('therapist')).toBe(true);
  });
});

/**
 * Where an invitation stops being available, which is the module's own rule
 * rather than a property of links.
 */
describe('re-issuing, and the door that closes for good', () => {
  let clock: ReturnType<typeof fixedClock>;
  let boss: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    clock = fixedClock(AT);
    boss = await makeUser('admin');
  });

  const deps = () => ({ clock, baseUrl: BASE });
  const tokenOf = (link: string) => link.split('/').pop()!;

  it('sends a fresh pair when the first expired', async () => {
    const first = await createAccount(actor(boss), ok(), deps());
    clock.advance(INVITE_TTL_MS);

    const second = await reissueInvitation(actor(boss), first.userId, deps());
    expect(second.code).not.toBe(first.code);
    expect(second.link).not.toBe(first.link);
    expect(await acceptInvitation(tokenOf(second.link), second.code, PASSWORD, { clock }))
      .toEqual({ ok: true });
  });

  it('supersedes the one still sitting in a mailbox', async () => {
    const first = await createAccount(actor(boss), ok(), deps());
    await reissueInvitation(actor(boss), first.userId, deps());

    expect(await resolveInvitation(tokenOf(first.link), { clock })).toBeNull();
    expect(await acceptInvitation(tokenOf(first.link), first.code, PASSWORD, { clock }))
      .toEqual({ ok: false, reason: 'no_invitation' });
  });

  /**
   * The line that keeps an administrator's powers from composing into a
   * takeover. An established clinician's account cannot be turned back into an
   * invitable one, so the only route to it is a reset — and a reset asks for
   * the second factor.
   */
  it('refuses an account whose owner has already set a password', async () => {
    const first = await createAccount(actor(boss), ok({ role: 'therapist' }), deps());
    await acceptInvitation(tokenOf(first.link), first.code, PASSWORD, { clock });

    await expect(reissueInvitation(actor(boss), first.userId, deps()))
      .rejects.toThrow(/already been set up/i);
  });

  /**
   * The composition written out, because reading two functions and concluding
   * it is safe is exactly the reasoning that misses these.
   *
   * Clearing somebody's second factor puts a clinical account back to mandatory
   * enrolment. It does not remove their password, so it does not make them
   * invitable — and `resolveReset` refuses a link to a clinical account with no
   * factor. Both doors stay shut.
   */
  it('stays shut after the practice manager clears the second factor', async () => {
    const first = await createAccount(actor(boss), ok({ role: 'therapist' }), deps());
    await acceptInvitation(tokenOf(first.link), first.code, PASSWORD, { clock });
    await prisma.user.update({
      where: { id: first.userId },
      data: { totpSecret: generateSecret(), totpEnrolledAt: clock.now() },
    });

    await clearSecondFactor(actor(boss), first.userId, { clock });

    await expect(reissueInvitation(actor(boss), first.userId, deps()))
      .rejects.toThrow(/already been set up/i);

    // And the reset flow refuses it too, so there is no route in at all — which
    // is the correct answer and the reason `clearSecondFactor` is a person
    // verifying a person rather than a link.
    const sent: string[] = [];
    await requestPasswordReset('rosa@example.test', {
      clock, baseUrl: BASE, mailer: { async send(_to, link) { sent.push(link); } },
    });
    expect(sent).toEqual([]);
  });

  it('is refused to every role but the practice manager', async () => {
    const first = await createAccount(actor(boss), ok(), deps());
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      const other = await makeUser(role);
      await expect(reissueInvitation(actor(other), first.userId, deps()))
        .rejects.toBeInstanceOf(Forbidden);
    }
  });

  /**
   * The refusal has to be the *same* refusal whatever state the account is in.
   *
   * Every check in this module reads the account before it authorizes, and a
   * refused caller who is told "that account has already been set up" has
   * learned something from a door that should have closed before the question
   * was asked. It is a small fact — but the shape is the one hard rule 4 is
   * about, and the row is the part that matters: a denial nobody logged is a
   * probe nobody can find afterwards.
   */
  it('refuses in the same words whether or not the account is claimed', async () => {
    const first = await createAccount(actor(boss), ok({ role: 'therapist' }), deps());
    await acceptInvitation(tokenOf(first.link), first.code, PASSWORD, { clock });
    const other = await makeUser('therapist');

    await expect(reissueInvitation(actor(other), first.userId, deps()))
      .rejects.toBeInstanceOf(Forbidden);

    const denial = await prisma.auditEvent.findFirst({
      where: { actorId: other.id, action: 'update', resource: 'user', allowed: false },
    });
    expect(denial).not.toBeNull();
  });
});

describe('somebody leaving, and coming back', () => {
  let clock: ReturnType<typeof fixedClock>;
  let boss: Awaited<ReturnType<typeof makeUser>>;
  let leaver: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    clock = fixedClock(AT);
    boss = await makeUser('admin');
    leaver = await makeUser('front_desk');
    await setPassword(leaver.id, PASSWORD, { clock });
  });

  it('ends the live sessions rather than waiting out an idle timeout', async () => {
    const signedIn = await signIn({ email: leaver.email, password: PASSWORD }, { clock });
    if (!signedIn.ok) throw new Error('expected a session');
    expect(await resolveSession(signedIn.token, { clock })).toMatchObject({ stage: 'ready' });

    await setAccountActive(actor(boss), leaver.id, false, { clock });

    expect(await resolveSession(signedIn.token, { clock })).toBeNull();
    expect(await signIn({ email: leaver.email, password: PASSWORD }, { clock }))
      .toEqual({ ok: false, reason: 'rejected' });
  });

  it('revokes what was in flight, so coming back is a fresh decision', async () => {
    const sent: string[] = [];
    await requestPasswordReset(leaver.email, {
      clock, baseUrl: BASE, mailer: { async send(_to, link) { sent.push(link); } },
    });
    const link = sent[0]!;
    expect(await resolveReset(link.split('/').pop()!, { clock })).not.toBeNull();

    await setAccountActive(actor(boss), leaver.id, false, { clock });
    await setAccountActive(actor(boss), leaver.id, true, { clock });

    expect(await resolveReset(link.split('/').pop()!, { clock })).toBeNull();
    expect(await signIn({ email: leaver.email, password: PASSWORD }, { clock }))
      .toMatchObject({ ok: true });
  });

  /**
   * Nothing here deletes a user. Their id is on every note they wrote and every
   * audit row they made, and a trail that can lose the person it names is not a
   * trail.
   */
  it('keeps the account and its trail', async () => {
    await setAccountActive(actor(boss), leaver.id, false, { clock });
    expect(await prisma.user.findUnique({ where: { id: leaver.id } })).not.toBeNull();
    expect(await prisma.auditEvent.count({
      where: { resourceId: leaver.id, action: 'update', allowed: true, reason: 'deactivated' },
    })).toBe(1);
  });

  it('refuses an invitation to a deactivated account', async () => {
    const fresh = await createAccount(actor(boss), ok(), { clock, baseUrl: BASE });
    await setAccountActive(actor(boss), fresh.userId, false, { clock });

    expect(await resolveInvitation(fresh.link.split('/').pop()!, { clock })).toBeNull();
    await expect(reissueInvitation(actor(boss), fresh.userId, { clock, baseUrl: BASE }))
      .rejects.toThrow(/deactivated/i);
  });

  it('is refused to every role but the practice manager', async () => {
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      const other = await makeUser(role);
      await expect(setAccountActive(actor(other), leaver.id, false, { clock }))
        .rejects.toBeInstanceOf(Forbidden);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: leaver.id } })).active).toBe(true);
  });
});
