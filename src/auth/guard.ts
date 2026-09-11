import { prisma, type Tx } from '../db';
import { Forbidden } from '../errors';
import { can, type Action, type Actor, type Decision, type Resource, type Target } from './permissions';

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
   * A reason CODE for the action itself, where the action has one — a fee
   * waiver's `goodwill`, and the amount it reversed. Never free text and never
   * clinical: this column is read by the one role that may not open a record.
   * A read that only a leave made possible carries `leave:<leaveId>` when the
   * action has no code of its own (leave P0-9). Break-glass justification
   * still fills it when nothing else does.
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
      reason: req.reason ??
        (decision.coveringLeaveId && `leave:${decision.coveringLeaveId}`) ??
        req.actor.breakGlass?.reason ?? null,
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
 *
 * `allowed: false` is for a refusal the matrix did not make: the public
 * enquiry form is permitted to `create` and is still turned away by a closed
 * door, a spent hourly allowance or a honeypot. Hard rule 4 wants those on the
 * record like any other denial, and the reason code is what distinguishes them
 * from a permission failure.
 */
export async function auditEvent(
  actor: Actor,
  action: Action,
  resource: Resource,
  opts: {
    resourceId?: string;
    clientId?: string;
    rule?: string;
    reason?: string;
    allowed?: boolean;
  } = {},
  tx?: Tx,
): Promise<void> {
  await record(tx ?? prisma, { actor, action, resource, ...opts }, {
    allowed: opts.allowed ?? true,
    rule: (opts.rule ?? 'system') as Decision['rule'],
    breakGlass: !!actor.breakGlass,
  });
}
