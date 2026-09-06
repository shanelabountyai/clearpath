import { createHash, randomBytes, randomInt } from 'node:crypto';
import { prisma, type Tx } from '../db';
import type { Clock } from '../clock';
import { Conflict } from '../errors';
import { authEvent, guarded } from './guard';
import { hashPassword, passwordComplaint } from './password';
import { requiresCoSignature, type Actor, type Role } from './permissions';

/**
 * Making an account exist, and the thing that is not a password reset.
 *
 * The two look identical in a form — an address, a link, a box to type a new
 * password into — and they answer different questions. A reset asks whether the
 * mailbox still belongs to the person who already holds this account: there is
 * a password, a factor, a history of sessions, and a body of clinical work
 * signed in their name. An invitation asks nothing about history because there
 * is none; what it hands over is an account that has never been used.
 *
 * The previous phase drew a hard line and this module has to stay on the right
 * side of it. `resetStage` **refuses** a clinical account that never enrolled,
 * because a link to one is a complete takeover on mailbox access alone — and
 * worse than the enrolled case, since whoever used it would then enrol their
 * own authenticator and hold the factor from then on. A brand new clinical
 * account is *exactly* that shape. So an invitation cannot be a link and
 * nothing else, or this phase quietly reopens the door the last one closed.
 *
 * What it is instead is two channels. The link goes to the mailbox. A short
 * code is shown to the administrator once, on screen, to be handed over some
 * other way — spoken across a desk, read out on a phone call. Neither half is
 * sufficient:
 *
 *   - somebody who can read the mailbox holds the link and not the code;
 *   - the administrator holds the code and not the mailbox.
 *
 * That is not a second *factor* and this module does not call it one. It is a
 * bootstrap split across two channels, and the honest statement of what it buys
 * is narrow: **an administrator cannot complete an invitation to a mailbox they
 * do not control.** They can of course create an account naming their own
 * address — deciding who works here is what the role is for — and that account
 * starts empty, is listed on the practice page, and leaves an audit row naming
 * who made it and what role they gave it.
 *
 * The rule that keeps this from becoming a takeover route for accounts that
 * *are* established is one line, `credentialRoute`, and it is the whole
 * security argument of the module: an invitation is only ever issuable to an
 * account that has never had a password. Once its owner sets one, that door is
 * closed permanently and the only way back in is `requestPasswordReset`, which
 * for a clinical account demands the factor. Composing the administrator's
 * powers does not get around it — clearing somebody's second factor puts their
 * account back to mandatory enrolment, but it does not remove their password,
 * so it does not make them invitable again.
 */

/**
 * How long an invitation stays live.
 *
 * Much longer than `RESET_TTL_MS`, and for a reason that is about people rather
 * than cryptography: a reset is somebody who is at their desk, blocked, asking
 * for a link right now. An invitation is sent to a person who does not work
 * here yet, and half its life is somebody waiting for a phone call about the
 * code. Thirty minutes would mean re-issuing it three times before it landed.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Wrong codes before the invitation is dead.
 *
 * The code is 40 bits, so five guesses is not what makes it unguessable — but a
 * code with no attempt limit sitting behind a URL an attacker already holds is
 * a design that only works because the arithmetic happens to be on its side,
 * and the arithmetic is one shortened code away from not being. Burning the
 * invitation is the right failure: re-issuing is one click for the practice
 * manager and a dead end for anybody else.
 */
export const MAX_CODE_ATTEMPTS = 5;

const TOKEN_BYTES = 32;

/**
 * Crockford's base32 alphabet, minus the letters it already excludes.
 *
 * The code is read aloud down a phone line and typed by somebody who has never
 * seen it written, so `I`/`1`, `O`/`0` and `U` are not in it. Thirty-two
 * symbols across eight characters is forty bits, which is the number the
 * attempt limit above is not carrying on its own.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/** The bearer halves are stored as digests, exactly as tokens and passwords are. */
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** A fresh code, grouped for reading out loud: `A1B2-C3D4`. */
export function generateInviteCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * What somebody typed, reduced to what they meant.
 *
 * Case, spaces and the hyphen are presentation. A person copying a code off a
 * sticky note types it lowercase and without the dash about half the time, and
 * refusing that is refusing the right answer badly — which then spends one of
 * five attempts.
 */
export function normalizeInviteCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Which door this account gets, and the one-line security argument of the file.
 *
 * `hasPassword` is the marker rather than "has ever signed in", and the
 * difference matters. An administrator never sets a password — there is no
 * function here that does — so a password exists on an account if and only if
 * its *owner* put one there, by accepting an invitation or completing a reset.
 * That makes this a statement about the account having been claimed, which is
 * the fact the decision actually turns on.
 *
 * `lastLoginAt` was the intuitive choice and is weaker: an account claimed an
 * hour ago whose owner has not yet come back would still read as invitable.
 */
export type CredentialRoute = 'invite' | 'reset';

export function credentialRoute(user: { hasPassword: boolean }): CredentialRoute {
  return user.hasPassword ? 'reset' : 'invite';
}

/**
 * The same answer for a list of accounts, for a screen that has to draw the
 * right button beside each row.
 *
 * Ids in, routes out. The practice page needs to know which of its rows have
 * been claimed and cannot ask directly, because `passwordHash` is on the list
 * of names that do not appear outside this module — and that lint is the reason
 * this function exists rather than a `select` on the page. Containment is only
 * containment if the way around it is also closed: what crosses the boundary
 * here is the conclusion, and there is no shape of careless `select` on the
 * other side that turns it back into a credential.
 */
export async function credentialRoutes(
  userIds: readonly string[],
): Promise<Record<string, CredentialRoute>> {
  if (userIds.length === 0) return {};
  const rows = await prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, passwordHash: true },
  });
  return Object.fromEntries(
    rows.map((r) => [r.id, credentialRoute({ hasPassword: !!r.passwordHash })]),
  );
}

export interface AccountInput {
  name: string;
  email: string;
  role: Role;
  supervisorId?: string | null;
}

/** Facts about the rest of the table, resolved by the caller before asking. */
export interface AccountContext {
  /** Whether some other account already holds this address. */
  emailTaken: boolean;
  /** The role of the account named as supervisor, or `null` if none was. */
  supervisorRole: Role | null;
}

/** The three roles whose work is a caseload, and the only ones supervision means anything for. */
const CLINICAL_ROLES: readonly Role[] = ['therapist', 'associate', 'supervisor'];

/**
 * What supervision means for a role, as a value a form can be built out of.
 *
 * This exists so that the "add someone" screen can enable and require the
 * supervisor field correctly without branching on a role itself. Hard rule 1
 * says no component draws its own conclusion from a role, and a form that
 * decided `role === 'associate'` for itself would be that — narrowly, in a way
 * that only affects which control is greyed out, and exactly the shape of
 * scattered role logic the rule exists to keep out of the codebase. The screen
 * asks; this file answers, next to the validation that enforces the same thing.
 */
export type SupervisionRule = 'required' | 'optional' | 'none';

export function supervisionRule(role: Role): SupervisionRule {
  if (requiresCoSignature(role)) return 'required';
  return CLINICAL_ROLES.includes(role) ? 'optional' : 'none';
}

/**
 * Whether this role may be named as somebody's supervisor.
 *
 * The other side of the same question, and here for the same reason: the form
 * has to fill a dropdown, and a page filtering a staff list on
 * `u.role === 'supervisor'` is a component deciding from a role. It is also
 * the check `accountComplaint` makes against data rather than against the
 * submitted form, so the two agreeing is one function rather than a convention.
 */
export function mayBeNamedSupervisor(role: Role): boolean {
  return role === 'supervisor';
}

/**
 * Why this account cannot be created, or `null` if it can.
 *
 * A sentence rather than a boolean, and the same shape as `passwordComplaint`
 * for the same reason: the person typing has to be told what to do differently.
 *
 * The rule worth the file is the associate one. `requiresCoSignature` says an
 * associate's progress note is not a complete record until their supervisor
 * countersigns it, and `signProgressNote` refuses with `no_supervisor` when
 * there is nobody to route it to. That refusal lands *after* the clinical work
 * is written — a session has happened, a note has been drafted, and the person
 * discovers at the moment they try to complete the record that their account
 * was never finished. Checking it here moves the same failure to the one moment
 * it costs nothing, which is the whole argument for validating at creation
 * rather than at use.
 */
export function accountComplaint(input: AccountInput, ctx: AccountContext): string | null {
  const name = input.name.trim();
  const email = input.email.trim();

  if (name.length < 2) return 'Give this person a name — it is what appears on their notes.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'That does not look like an email address, and it is where the invitation goes.';
  }
  if (ctx.emailTaken) {
    return 'Somebody here already has that address. An address identifies exactly one account.';
  }
  // Not an oversight and not a role anybody is short of: `client` exists so a
  // form submitted through a tokenized link has an honest actor in the audit
  // trail. Nobody signs in as one, so creating one here would make an account
  // with a door and no room behind it.
  if (input.role === 'client') {
    return 'Clients do not have accounts here. They reach their own schedule through a link.';
  }

  const supervisorId = input.supervisorId?.trim() || null;

  if (supervisorId && !CLINICAL_ROLES.includes(input.role)) {
    return 'Only clinicians are supervised. Front desk, the practice manager and the auditor are not.';
  }
  if (supervisorId && ctx.supervisorRole !== 'supervisor') {
    return 'The person named as supervisor does not hold the supervisor role.';
  }
  if (requiresCoSignature(input.role) && !supervisorId) {
    return 'An associate needs a supervisor. Without one their notes can be written and signed '
      + 'but never completed, and they find that out after the session rather than before it.';
  }

  return null;
}

export interface Deps {
  clock: Clock;
}

/**
 * The two halves of a new account's way in, returned together and once.
 *
 * The code is plaintext here and nowhere else — only its digest is written
 * down. It is returned rather than sent because the administrator *is* the
 * second channel: they read it out, and the value of it depends entirely on it
 * not travelling by the same route as the link.
 */
export interface Invitation {
  userId: string;
  /** The URL that goes to the person's mailbox. */
  link: string;
  /** Shown to the administrator once. Never stored, never mailed, never in a URL. */
  code: string;
  expiresAt: Date;
}

interface IssueDeps extends Deps {
  baseUrl: string;
}

/**
 * An id for a row that does not exist yet.
 *
 * Every other model lets the database invent one with `@default(cuid())`, and
 * this is the one place that cannot: `guarded` authorizes *before* it runs the
 * work and writes its audit row from the request it was handed, so an id the
 * insert invents halfway through is an id the row naming the decision never
 * sees. The alternatives are both worse — an audit row for account creation
 * with no `resourceId`, or creating the account first and authorizing
 * afterwards, which is authorization that arrives too late to refuse anything.
 */
const newUserId = () => `c${randomBytes(12).toString('hex')}`;

/**
 * Write the invitation rows. Callers reach this through the two guarded
 * entry points below, which is where authorization and the audit row live.
 */
async function issue(
  tx: Tx,
  userId: string,
  { clock, baseUrl }: IssueDeps,
): Promise<Invitation> {
  const now = clock.now();
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const code = generateInviteCode();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  // One live invitation per account, for the same reason one live reset link:
  // a superseded invitation is a second way in still sitting in a mailbox.
  await tx.invitation.updateMany({
    where: { userId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now, revokedReason: 'superseded' },
  });
  await tx.invitation.create({
    data: {
      userId,
      tokenHash: digest(token),
      codeHash: digest(normalizeInviteCode(code)),
      createdAt: now,
      expiresAt,
    },
  });

  return { userId, link: `${baseUrl}/invite/${token}`, code, expiresAt };
}

/**
 * Create a staff account, and hand back the two halves of its way in.
 *
 * The account is created with no password and nothing here can give it one.
 * That is the point rather than an omission: an administrator who could *set*
 * a password would, combined with `clearSecondFactor` — which they already
 * hold — be an administrator who could sign in as any clinician in the
 * building, and every audit row from that session would name the clinician.
 * The two powers are individually defensible and compose into impersonation,
 * so the composition is refused at the only place it could be introduced.
 */
export async function createAccount(
  actor: Actor,
  input: AccountInput,
  deps: IssueDeps,
): Promise<Invitation> {
  const email = input.email.trim();
  const supervisorId = input.supervisorId?.trim() || null;
  const id = newUserId();

  return guarded(
    // The role granted is the whole substance of the decision, so it is in the
    // row rather than only in the account it made. Creating an account is the
    // one action by which a role manufactures another role, which puts it in
    // the same class as break-glass: what is available is not prevention but a
    // row that says exactly what was handed out and to whom.
    { actor, action: 'create', resource: 'user', resourceId: id, reason: `role:${input.role}` },
    async (tx) => {
      // Validated inside the guard, not before it. Reading the account first
      // and complaining first means a caller the matrix would have refused is
      // answered by the *domain* — "somebody already has that address" — from a
      // door that should have shut before the question was asked, and with no
      // denial row, which is the half of hard rule 4 that is easy to lose.
      // A `Conflict` thrown here rolls the whole transaction back, allowed row
      // included, which is the guard's own rule: the log records accesses that
      // happened.
      const [existing, supervisor] = await Promise.all([
        tx.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
          select: { id: true },
        }),
        supervisorId
          ? tx.user.findUnique({ where: { id: supervisorId }, select: { role: true } })
          : Promise.resolve(null),
      ]);
      const complaint = accountComplaint(input, {
        emailTaken: !!existing,
        supervisorRole: supervisor?.role ?? null,
      });
      if (complaint) throw new Conflict(complaint, 'invalid_account');

      await tx.user.create({
        data: {
          id,
          name: input.name.trim(),
          email,
          role: input.role,
          supervisorId,
          createdAt: deps.clock.now(),
        },
      });
      const invitation = await issue(tx, id, deps);
      await authEvent({ id, role: input.role }, 'invite_issued', {
        allowed: true, rule: 'invitation', reason: 'created',
      }, tx);
      return invitation;
    },
  );
}

/**
 * Send somebody their way in again, because the first one expired or never
 * arrived.
 *
 * Refused for an account that has a password, and that refusal is
 * `credentialRoute` rather than a condition written out here — the one rule
 * that stops an administrator from turning an established clinician's account
 * back into an invitable one. Somebody in that position gets a reset, and a
 * reset asks for their second factor.
 */
export async function reissueInvitation(
  actor: Actor,
  userId: string,
  deps: IssueDeps,
): Promise<Invitation> {
  return guarded(
    { actor, action: 'update', resource: 'user', resourceId: userId, reason: 'invite_reissued' },
    async (tx) => {
      // Inside the guard for the reason `createAccount` gives above: a caller
      // the matrix refuses must be told the same thing whatever state the
      // account is in, and must leave a denial row. Reading first and
      // complaining first told them "that account has already been set up" and
      // logged nothing.
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, active: true, passwordHash: true },
      });
      if (!user) throw new Conflict('No such account', 'no_account');
      if (!user.active) {
        throw new Conflict('That account is deactivated. Reactivate it first.', 'inactive');
      }
      if (credentialRoute({ hasPassword: !!user.passwordHash }) !== 'invite') {
        throw new Conflict(
          'That account has already been set up. Somebody locked out of it asks for a '
          + 'password reset, which asks for their second factor.',
          'already_claimed',
        );
      }

      const invitation = await issue(tx, userId, deps);
      await authEvent({ id: userId, role: user.role }, 'invite_issued', {
        allowed: true, rule: 'invitation', reason: 'reissued',
      }, tx);
      return invitation;
    },
  );
}

export interface ResolvedInvitation {
  invitationId: string;
  user: { id: string; name: string; email: string; role: Role };
}

/**
 * Load the invitation a token names, or `null` if it is not usable.
 *
 * Not usable covers unknown, expired, spent, superseded, burnt through its
 * attempts, an account deactivated since it was issued, and — the one that is
 * this module's own rule — an account that has since been claimed. All of them
 * are one `null`, for the reason `resolveReset` gives: a page distinguishing
 * "expired" from "never existed" is a staff-list oracle in a smaller window.
 *
 * Does not advance anything, and does not reveal the code.
 */
export async function resolveInvitation(
  token: string,
  { clock }: Deps,
): Promise<ResolvedInvitation | null> {
  if (!token) return null;
  const now = clock.now();

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: digest(token) },
    select: {
      id: true, expiresAt: true, acceptedAt: true, revokedAt: true, attempts: true,
      user: { select: { id: true, name: true, email: true, role: true, active: true, passwordHash: true } },
    },
  });
  if (!invitation) return null;
  if (invitation.acceptedAt || invitation.revokedAt) return null;
  if (invitation.expiresAt <= now) return null;
  if (invitation.attempts >= MAX_CODE_ATTEMPTS) return null;
  if (!invitation.user.active) return null;

  const { active: _active, passwordHash, ...user } = invitation.user;
  if (credentialRoute({ hasPassword: !!passwordHash }) !== 'invite') return null;

  return { invitationId: invitation.id, user };
}

export type AcceptResult =
  | { ok: true }
  | { ok: false; reason: 'no_invitation' }
  | { ok: false; reason: 'wrong_code'; attemptsLeft: number }
  | { ok: false; reason: 'weak'; complaint: string };

/**
 * Prove both halves and claim the account.
 *
 * The code and the password arrive together on one screen rather than as two
 * steps, and that is not a shortcut. A reset splits them because the second
 * factor is a *challenge* — something the account already holds, checked
 * against a clock. The code here is the other half of one credential that was
 * split when it was issued, so there is no meaningful state between "typed the
 * code" and "chose a password": storing a half-proved invitation would just be
 * a second window for the link alone to be enough.
 *
 * Signs nobody in, exactly as `completeReset` signs nobody in. The person goes
 * to the front door, which for a clinical role is where mandatory enrolment
 * happens — so the second factor this module never asked for is demanded by
 * the sign-in on the very next screen, before the account can do anything.
 */
export async function acceptInvitation(
  token: string,
  code: string,
  password: string,
  { clock }: Deps,
): Promise<AcceptResult> {
  const now = clock.now();
  const resolved = await resolveInvitation(token, { clock });
  if (!resolved) return { ok: false, reason: 'no_invitation' };

  const invitation = await prisma.invitation.findUnique({
    where: { id: resolved.invitationId },
    select: { codeHash: true, attempts: true },
  });
  if (!invitation) return { ok: false, reason: 'no_invitation' };

  const subject = { id: resolved.user.id, role: resolved.user.role };

  if (digest(normalizeInviteCode(code)) !== invitation.codeHash) {
    const attempts = invitation.attempts + 1;
    const burnt = attempts >= MAX_CODE_ATTEMPTS;
    await prisma.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: resolved.invitationId },
        data: {
          attempts,
          ...(burnt ? { revokedAt: now, revokedReason: 'code_attempts' } : {}),
        },
      });
      await authEvent(subject, 'invite_accepted', {
        allowed: false, rule: 'invitation', reason: burnt ? 'code_attempts' : 'wrong_code',
      }, tx);
    });
    return { ok: false, reason: 'wrong_code', attemptsLeft: MAX_CODE_ATTEMPTS - attempts };
  }

  // Checked after the code on purpose. A weak password must not cost an
  // attempt, and telling somebody their password is short before they have
  // proved anything would answer a question the link alone should not answer.
  const complaint = passwordComplaint(password);
  if (complaint) return { ok: false, reason: 'weak', complaint };

  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: resolved.user.id },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    await tx.invitation.update({
      where: { id: resolved.invitationId },
      data: { acceptedAt: now },
    });
    await authEvent(subject, 'invite_accepted', {
      allowed: true, rule: 'invitation', reason: 'claimed',
    }, tx);
  });

  return { ok: true };
}

/**
 * Somebody left, or came back.
 *
 * Deactivation is the whole of "removing" an account: nothing here deletes a
 * user, because their id is on every note they wrote and every audit row they
 * made, and a trail that can lose the person it names is not a trail.
 * `resolveSession` and `signIn` both refuse an inactive account, so this is
 * immediate rather than a change that takes effect at the next idle timeout —
 * and the live sessions go with it, because somebody who has left the practice
 * should not keep a client's record open on the way out of the building.
 *
 * Reactivating restores nothing but the ability to sign in. Any invitation or
 * reset link that was in flight when the account was switched off stays
 * revoked, which is why coming back is a fresh decision rather than a resumed
 * one.
 */
export async function setAccountActive(
  actor: Actor,
  userId: string,
  active: boolean,
  { clock }: Deps,
): Promise<void> {
  const now = clock.now();
  await guarded(
    {
      actor, action: 'update', resource: 'user', resourceId: userId,
      reason: active ? 'reactivated' : 'deactivated',
    },
    async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { active } });
      if (active) return;
      await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'deactivated' },
      });
      await tx.invitation.updateMany({
        where: { userId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'deactivated' },
      });
      await tx.passwordReset.updateMany({
        where: { userId, usedAt: null, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'deactivated' },
      });
    },
  );
}
