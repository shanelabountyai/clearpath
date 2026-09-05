import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import type { Tx } from '../db';
import { NotFound } from '../errors';
import { toCsv as csv } from '../csv';

/**
 * The auditor's surface. Read-only, and pointedly the only role that has it:
 * the practice manager who can break glass into a record cannot read the log of
 * who broke glass, and the auditor who reads that log cannot open a record.
 */

interface AuditFilters {
  clientId?: string;
  actorId?: string;
  resource?: string;
  from?: Date;
  to?: Date;
  /** Break-glass entries and denials — the two things an audit is usually for. */
  flaggedOnly?: boolean;
  deniedOnly?: boolean;
  limit?: number;
  cursor?: string;
}

export async function queryAuditLog(actor: Actor, filters: AuditFilters = {}) {
  const take = Math.min(filters.limit ?? 100, 1000);

  return guarded(
    { actor, action: 'read', resource: 'audit_log' },
    async (tx: Tx) => {
      const where = {
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
        ...(filters.actorId ? { actorId: filters.actorId } : {}),
        ...(filters.resource ? { resource: filters.resource } : {}),
        ...(filters.flaggedOnly ? { breakGlass: true } : {}),
        ...(filters.deniedOnly ? { allowed: false } : {}),
        ...(filters.from || filters.to
          ? { at: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
          : {}),
      };

      const rows = await tx.auditEvent.findMany({
        where,
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      });

      return {
        rows: rows.slice(0, take),
        nextCursor: rows.length > take ? rows[take - 1]!.id : null,
        total: await tx.auditEvent.count({ where }),
      };
    },
  );
}

/**
 * The evidence behind one automatic charge.
 *
 * P0-9. A fee the practice applied because nobody answered has to be
 * answerable to somebody who was not there: how many times was this client
 * asked, did they ever reply, who decided that silence was the answer, and
 * what did it cost. All four are countable, and none of them requires reading
 * anything the practice sent or the client said.
 *
 * It is an auditor surface, gated on `audit_log` like the rest of this module —
 * so the role that can read it still cannot open the record it describes. What
 * comes back is ids, stage names, counts and integer cents. The client's name,
 * their number and the message bodies stay where they are.
 */
export async function confirmationTrail(actor: Actor, appointmentId: string) {
  return guarded(
    { actor, action: 'read', resource: 'audit_log', resourceId: appointmentId },
    async (tx: Tx) => {
      const appt = await tx.appointment.findUnique({
        where: { id: appointmentId },
        select: {
          id: true, clientId: true, startAt: true, status: true, confirmation: true,
          chargeFeeCents: true, feeWaivedAt: true, feeWaiveReason: true,
          // The proof the practice asked, which is what the fee rests on.
          reminders: {
            where: { outboxMessageId: { not: null } },
            select: { stage: true, dueAt: true, sentAt: true },
            orderBy: { dueAt: 'asc' },
          },
        },
      });
      if (!appt) throw new NotFound('Appointment');

      const events = await tx.auditEvent.findMany({
        where: { resourceId: appointmentId, resource: 'appointment' },
        orderBy: { at: 'asc' },
        select: { at: true, actorId: true, actorRole: true, action: true, allowed: true, rule: true, reason: true },
      });

      return {
        appointmentId: appt.id,
        clientId: appt.clientId,
        startAt: appt.startAt,
        status: appt.status,
        confirmation: appt.confirmation,
        /** One per stage the practice actually queued. */
        sends: appt.reminders.length,
        stages: appt.reminders.map((r) => r.stage),
        /** Anything the client did behind their own link. Zero is the case a fee rests on. */
        answers: events.filter((e) => e.actorRole === 'client').length,
        /** The sweep concluding that silence was the answer. Exactly one, or none. */
        determinations: events.filter((e) => e.reason === 'no_response').length,
        feeCents: appt.chargeFeeCents,
        waived: appt.feeWaivedAt !== null,
        waiveReason: appt.feeWaiveReason,
        events,
      };
    },
  );
}

/**
 * Every appointment whose fee this feature produced.
 *
 * The filter an auditor actually wants: not "show me no-shows" but "show me
 * the charges nobody decided" — the ones a rule applied on its own. Ordered
 * most recent first, because the question is usually about last month.
 */
export async function noResponseFees(
  actor: Actor,
  opts: { from?: Date; to?: Date; limit?: number } = {},
) {
  return guarded(
    { actor, action: 'read', resource: 'audit_log' },
    (tx: Tx) =>
      tx.appointment.findMany({
        where: {
          confirmation: 'no_response',
          status: 'no_show',
          chargeFeeCents: { not: null },
          ...(opts.from || opts.to
            ? { startAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
            : {}),
        },
        select: {
          id: true, clientId: true, startAt: true, chargeFeeCents: true, feeWaivedAt: true,
        },
        orderBy: { startAt: 'desc' },
        take: Math.min(opts.limit ?? 100, 1000),
      }),
  );
}

const CSV_COLUMNS = [
  'at', 'actorId', 'actorRole', 'action', 'resource', 'resourceId',
  'clientId', 'allowed', 'rule', 'breakGlass', 'reason',
] as const;

/** CSV of an audit result. Ids only, exactly like the rows themselves. */
export const toCsv = (rows: Record<string, unknown>[]): string => csv(CSV_COLUMNS, rows);
