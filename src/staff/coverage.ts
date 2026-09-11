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

/**
 * Each supervisor's open leave, and who covers their supervision under it
 * (leave P1-3). The same "which leave" as `coverageOf` — the earliest not
 * cancelled and not yet over — and the same refusal to decide whether it is on
 * today: `coversAuthorSupervisor` does that (D-14). A leave naming no
 * supervision cover resolves to nothing, and nothing grants.
 */
export async function supervisionCoverageOf(
  db: Db,
  supervisorIds: readonly (string | null | undefined)[],
  today: LocalDate,
): Promise<Map<string, Coverage>> {
  const out = new Map<string, Coverage>();
  const ids = [...new Set(supervisorIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return out;

  const leaves = await db.leave.findMany({
    where: { userId: { in: ids }, cancelledAt: null, toDate: { gte: dbDate(today) } },
    orderBy: { fromDate: 'asc' },
    select: { id: true, userId: true, coveringSupervisorId: true, fromDate: true, toDate: true, cancelledAt: true },
  });
  const seen = new Set<string>();
  for (const l of leaves) {
    if (seen.has(l.userId)) continue;
    seen.add(l.userId);
    if (!l.coveringSupervisorId) continue;
    out.set(l.userId, {
      leaveId: l.id, coveringClinicianId: l.coveringSupervisorId,
      fromDate: localDate(l.fromDate), toDate: localDate(l.toDate), cancelledAt: l.cancelledAt,
    });
  }
  return out;
}

/**
 * The supervisors this person is named to cover on a leave not yet over, each
 * with their supervisees and the coverage the matrix decides on. Not filtered
 * by today: the caller asks `can` with the cell it is about to use, so a list
 * never names somebody the record would refuse. The cover is never counted as
 * their own supervisee, since nobody countersigns their own note.
 */
export async function supervisionCoveredBy(db: Db, actorId: string, today: LocalDate) {
  const leaves = await db.leave.findMany({
    where: { coveringSupervisorId: actorId, cancelledAt: null, toDate: { gte: dbDate(today) } },
    select: {
      id: true, userId: true, fromDate: true, toDate: true, cancelledAt: true,
      user: { select: { supervisees: { where: { id: { not: actorId } }, select: { id: true } } } },
    },
  });
  return leaves.map((l) => ({
    supervisorId: l.userId,
    superviseeIds: l.user.supervisees.map((s) => s.id),
    coverage: {
      leaveId: l.id, coveringClinicianId: actorId,
      fromDate: localDate(l.fromDate), toDate: localDate(l.toDate), cancelledAt: l.cancelledAt,
    } satisfies Coverage,
  }));
}

export interface AlertRoute {
  recipientId: string;
  /** Set exactly when coverage chose the recipient, so the boundary sweep knows what to move back. */
  coveringLeaveId: string | null;
}

/** What routing reads about a client: who treats them, and whether that person is still here. */
export const ROUTED_CLIENT = {
  id: true, treatingClinicianId: true, treatingClinician: { select: { active: true, supervisorId: true } },
} as const;
export type RoutedClient = {
  id: string; treatingClinicianId: string; treatingClinician: { active: boolean; supervisorId: string | null };
};

/**
 * Whose an alert about this client is when nobody is away: the treating
 * clinician, or once they have departed, the supervisor departure P0-7 hands
 * their unread alerts to (D-26). A departed clinician with no supervisor keeps
 * it, which is the case the departure blocker refuses to close over.
 */
export function ownerOf(c: RoutedClient): string {
  return c.treatingClinician.active ? c.treatingClinicianId : c.treatingClinician.supervisorId ?? c.treatingClinicianId;
}

/**
 * Where an alert goes today: the owner's cover while the owner's leave is on,
 * else the owner.
 *
 * Routing, not authorization, so it does not ask the matrix. It asks
 * `leavePhase`, the function `covers` asks, so an alert reaches the coverer on
 * exactly the days the coverer can open the record behind it.
 */
export function routeOf(ownerId: string, coverage: Coverage | undefined, today: LocalDate): AlertRoute {
  return coverage && leavePhase(coverage, today) === 'active'
    ? { recipientId: coverage.coveringClinicianId, coveringLeaveId: coverage.leaveId }
    : { recipientId: ownerId, coveringLeaveId: null };
}

/**
 * Each client's alert route today, keyed by client id. A treating clinician
 * away is covered by client (`coverageOf`). A departed clinician's supervisor
 * away is covered by supervision (`supervisionCoverageOf`), the same fact
 * `clientTarget` grants the cover's read on, so the cover can open the record
 * on the days the alert is theirs.
 */
export async function routesOf(
  db: Db,
  clients: readonly RoutedClient[],
  today: LocalDate,
): Promise<Map<string, AlertRoute>> {
  const departed = clients.filter((c) => ownerOf(c) !== c.treatingClinicianId);
  const [coverage, supervision] = await Promise.all([
    coverageOf(db, clients.filter((c) => ownerOf(c) === c.treatingClinicianId), today),
    supervisionCoverageOf(db, departed.map(ownerOf), today),
  ]);
  return new Map(clients.map((c) => {
    const owner = ownerOf(c);
    return [c.id, routeOf(owner, owner === c.treatingClinicianId ? coverage.get(c.id) : supervision.get(owner), today)];
  }));
}

/**
 * The one person an alert about this client goes to (P0-5, hard rule 9).
 *
 * Both alert-creation sites call this, so a third cannot forget coverage:
 * there is only one function to call.
 */
export async function alertRecipient(db: Db, clientId: string, today: LocalDate): Promise<AlertRoute> {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: ROUTED_CLIENT });
  return (await routesOf(db, [client], today)).get(clientId)!;
}
