import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import type { Tx } from '../db';
import { toCsv as csv } from '../csv';

/**
 * The auditor's surface. Read-only, and pointedly the only role that has it:
 * the practice manager who can break glass into a record cannot read the log of
 * who broke glass, and the auditor who reads that log cannot open a record.
 */

export interface AuditFilters {
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

const CSV_COLUMNS = [
  'at', 'actorId', 'actorRole', 'action', 'resource', 'resourceId',
  'clientId', 'allowed', 'rule', 'breakGlass', 'reason',
] as const;

/** CSV of an audit result. Ids only, exactly like the rows themselves. */
export const toCsv = (rows: Record<string, unknown>[]): string => csv(CSV_COLUMNS, rows);

/** "Who touched this client, and what did they do." The question the log exists for. */
export async function clientAccessTrail(actor: Actor, clientId: string, limit = 200) {
  return queryAuditLog(actor, { clientId, limit });
}
