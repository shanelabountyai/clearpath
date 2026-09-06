import { prisma, type Tx } from '../db';
import { Forbidden } from '../errors';
import { can, type Action, type Actor, type Decision, type Resource, type Role, type Target } from './permissions';

/**
 * The single door to client data.
 *
 * Every call decides with the permission matrix and records the decision — grant
 * *or* denial — in the same database transaction as the work it guards. Nothing
 * reads or writes a client record without passing through here, which is what
 * makes "who accessed client X" answerable rather than aspirational.
 *
 * Audit rows carry ids only. No names, no note content, no answers, no scores:
 * a log that leaks what it was protecting is worse than no log, because it
 * concentrates the leak in the one table everybody is allowed to read.
 */
interface GuardRequest {
  actor: Actor;
  action: Action;
  resource: Resource;
  /** Relationship facts, resolved from data by the caller before the check. */
  target?: Target;
  /** Id of the specific row being touched, when there is one. */
  resourceId?: string;
  /** The client whose record this belongs to. Indexed for auditor queries. */
  clientId?: string;
  /**
   * An operational note for the trail — a reason code, and the figure a
   * reversal reversed. Never content, never a name, never an answer: the same
   * bar the break-glass justification passes, which is the other thing that
   * writes this column.
   */
  reason?: string;
}

async function record(db: Tx | typeof prisma, req: GuardRequest, decision: Decision) {
  await db.auditEvent.create({
    data: {
      actorId: req.actor.id,
      actorRole: req.actor.role,
      action: req.action,
      resource: req.resource,
      resourceId: req.resourceId ?? null,
      clientId: req.clientId ?? null,
      allowed: decision.allowed,
      rule: decision.rule,
      breakGlass: decision.breakGlass,
      // An explicit note wins over the break-glass justification, and in
      // practice they never both apply: break-glass reaches records, not money.
      reason: req.reason ?? req.actor.breakGlass?.reason ?? null,
    },
  });
}

/**
 * Authorize without doing any work. Use when a surface needs to know whether to
 * render an affordance. Silent — deciding what buttons to draw is not an access
 * event, and logging it would bury the real ones.
 */
export function may(req: GuardRequest): boolean {
  return can(req.actor, req.action, req.resource, req.target ?? {}).allowed;
}

/**
 * Would break-glass change this answer?
 *
 * Used to decide which refusal a person sees. Offering "break glass" to someone
 * who has no such power is a door that does not open, and offering it where the
 * answer is absolute -- a process note -- would misrepresent the rule.
 */
export function breakGlassWouldHelp(req: GuardRequest): boolean {
  if (may(req)) return false;
  return may({ ...req, actor: { ...req.actor, breakGlass: { reason: 'probe' } } });
}

/**
 * Authorize, then run `work` and log the access atomically.
 *
 * Pass `tx` to join a transaction already in flight; otherwise one is opened.
 * If `work` throws, the audit row rolls back with it — the log records accesses
 * that happened, not accesses that were attempted and failed on a bug.
 */
export async function guarded<T>(
  req: GuardRequest,
  work: (tx: Tx) => Promise<T>,
  tx?: Tx,
): Promise<T> {
  const decision = can(req.actor, req.action, req.resource, req.target ?? {});

  if (!decision.allowed) {
    // The denial is the point. It is written outside any caller transaction so
    // that a rolled-back request still leaves the attempt on the record.
    await record(prisma, req, decision);
    throw new Forbidden(req.resource, req.action, req.resource === 'process_note');
  }

  if (tx) {
    const result = await work(tx);
    await record(tx, req, decision);
    return result;
  }

  return prisma.$transaction(async (t) => {
    const result = await work(t as Tx);
    await record(t as Tx, req, decision);
    return result;
  });
}

/**
 * Authorize N client records for one indivisible piece of work.
 *
 * A group session writes to six clients' records in one transaction, and hard
 * rule 4 wants six audit rows saying so — one per record touched, each naming
 * its own client, all committing or rolling back with the work. Nesting the
 * guard is how that stays honest: every request goes through the matrix, any
 * one denial refuses the whole thing, and the audit rows land in the same
 * transaction as the appointments they describe.
 */
export function guardedAll<T>(
  reqs: readonly GuardRequest[],
  work: (tx: Tx) => Promise<T>,
  tx?: Tx,
): Promise<T> {
  const [head, ...rest] = reqs;
  if (!head) throw new TypeError('guardedAll needs at least one request');
  return guarded(head, (t) => (rest.length ? guardedAll(rest, work, t) : work(t)), tx);
}

/**
 * Log an event that is not itself a data access — a threshold alert firing, a
 * break-glass session opening. Carries reason codes, never content.
 */
export async function auditEvent(
  actor: Actor,
  action: Action,
  resource: Resource,
  opts: { resourceId?: string; clientId?: string; rule?: string; reason?: string } = {},
  tx?: Tx,
): Promise<void> {
  await record(tx ?? prisma, { actor, action, resource, ...opts }, {
    allowed: true,
    rule: (opts.rule ?? 'system') as Decision['rule'],
    breakGlass: !!actor.breakGlass,
  });
}

/**
 * Things that happen at the door, before there is an actor.
 *
 * Deliberately not routed through `can()`. Authentication is not
 * authorization: there is no matrix cell for "may this person prove who they
 * are", and inventing one would put a rule in `permissions.ts` that answers a
 * question that file does not ask. What these rows share with the rest of the
 * trail is the shape — ids, a reason code, and an `allowed` flag — so an
 * auditor reading the log sees refused sign-ins next to refused reads.
 *
 * `actorId` names the *account the attempt was made against*, which for a
 * failure is not a claim that the account's owner made it. `allowed: false`
 * beside it is what says an attempt was refused, and that is the whole
 * statement the row makes.
 */
export type AuthAction =
  | 'sign_in' | 'sign_out' | 'enrol_second_factor'
  /**
   * Password recovery, as three events rather than one.
   *
   * A request, a factor proved, and a password set are separately interesting
   * to somebody reading the trail afterwards: a run of `reset_request` rows
   * against one account with no `reset_complete` after them is somebody
   * probing, and a `reset_complete` with no `reset_second_factor` before it on
   * a clinical account would be the bug this whole phase exists to prevent —
   * visible in the log rather than only in a branch.
   */
  | 'reset_request' | 'reset_second_factor' | 'reset_complete'
  /**
   * An account existing, and an account being claimed.
   *
   * `invite_issued` sits beside the `guarded` row that authorized the creation
   * rather than replacing it: the guard's row names the administrator who
   * decided, and this one names the account the decision was about, with no
   * actor to attribute it to yet. `invite_accepted` has the same shape as a
   * refused sign-in and for the same reason — a run of `allowed: false` rows
   * against one new account is somebody guessing at the code, and it should
   * read like the guessing it is.
   */
  | 'invite_issued' | 'invite_accepted';

export async function authEvent(
  subject: { id: string; role: Role },
  action: AuthAction,
  opts: { allowed: boolean; rule: string; reason?: string },
  tx?: Tx,
): Promise<void> {
  await (tx ?? prisma).auditEvent.create({
    data: {
      actorId: subject.id,
      actorRole: subject.role,
      action,
      resource: 'user',
      resourceId: subject.id,
      clientId: null,
      allowed: opts.allowed,
      rule: opts.rule,
      breakGlass: false,
      // Reason codes only. Never the address that was typed, never the string
      // that was typed into the password box — people put passwords in the
      // email field, and this table is append-only by database rule.
      reason: opts.reason ?? null,
    },
  });
}
