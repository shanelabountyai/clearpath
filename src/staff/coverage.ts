import type { Target } from '../auth/permissions';
import { prisma, type Tx } from '../db';
import type { LocalDate } from '../time';
import { leavePhase } from './leave';

/**
 * Who covers a client, resolved once for every caller (leave Phase 3).
 *
 * Record reads, the caseload list and alert routing all ask this, so a leave
 * split by client cannot mean one coverer to the record and another to the
 * alert. Imports only the database and `leave.ts`: the client repository, the
 * form service and the inbound handler all reach here, and a guard or service
 * import would be a cycle through them.
 */

type Db = Tx | typeof prisma;
export type Coverage = NonNullable<Target['coverage']>;

const dbDate = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const localDate = (d: Date): LocalDate => d.toISOString().slice(0, 10);

/**
 * Each client's coverage under their treating clinician's open leave.
 *
 * Which leave: the earliest that is not cancelled and not yet over, which is
 * the one under way when there is one, because two live leaves never share a
 * day. Which coverer: the client's own `LeaveCoverage` row, else the leave's.
 * Whether the leave is on *today* is not decided here. An upcoming leave comes
 * back with its dates and `covers` says no (D-14).
 */
export async function coverageOf(
  db: Db,
  clients: readonly { id: string; treatingClinicianId: string }[],
  today: LocalDate,
): Promise<Map<string, Coverage>> {
  const out = new Map<string, Coverage>();
  if (clients.length === 0) return out;

  const leaves = await db.leave.findMany({
    where: {
      userId: { in: [...new Set(clients.map((c) => c.treatingClinicianId))] },
      cancelledAt: null,
      toDate: { gte: dbDate(today) },
    },
    orderBy: { fromDate: 'asc' },
    select: {
      id: true, userId: true, coveringClinicianId: true, fromDate: true, toDate: true, cancelledAt: true,
      coverage: { where: { clientId: { in: clients.map((c) => c.id) } }, select: { clientId: true, coveringClinicianId: true } },
    },
  });

  for (const c of clients) {
    const leave = leaves.find((l) => l.userId === c.treatingClinicianId);
    if (!leave) continue;
    out.set(c.id, {
      leaveId: leave.id,
      coveringClinicianId: leave.coverage.find((r) => r.clientId === c.id)?.coveringClinicianId ?? leave.coveringClinicianId,
      fromDate: localDate(leave.fromDate),
      toDate: localDate(leave.toDate),
      cancelledAt: leave.cancelledAt,
    });
  }
  return out;
}

export interface AlertRoute {
  recipientId: string;
  /** Set exactly when coverage chose the recipient, so the boundary sweep knows what to move back. */
  coveringLeaveId: string | null;
}

/**
 * Where an alert about this client goes today, given what `coverageOf` found.
 *
 * Routing, not authorization, so it does not ask the matrix. It asks
 * `leavePhase`, the function `covers` asks, so an alert reaches the coverer on
 * exactly the days the coverer can open the record behind it.
 */
export function routeOf(
  client: { treatingClinicianId: string },
  coverage: Coverage | undefined,
  today: LocalDate,
): AlertRoute {
  return coverage && leavePhase(coverage, today) === 'active'
    ? { recipientId: coverage.coveringClinicianId, coveringLeaveId: coverage.leaveId }
    : { recipientId: client.treatingClinicianId, coveringLeaveId: null };
}

/**
 * The one person an alert about this client goes to (P0-5, hard rule 9).
 *
 * Both alert-creation sites call this, so a third cannot forget coverage:
 * there is only one function to call.
 */
export async function alertRecipient(db: Db, clientId: string, today: LocalDate): Promise<AlertRoute> {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, treatingClinicianId: true } });
  return routeOf(client, (await coverageOf(db, [client], today)).get(clientId), today);
}
