import { randomUUID } from 'node:crypto';
import { auditEvent, guarded } from '../auth/guard';
import { requiresCoSignature, type Actor } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma, type Tx } from '../db';
import { Conflict, NotFound } from '../errors';
import { SYSTEM_ACTOR } from '../scheduling/reminders';
import { addDays, localDateOf, type LocalDate } from '../time';
import { coverageOf, routeOf } from './coverage';
import { maySupervise, mayTreat } from './departure';
import { canTransition, leavePhase } from './leave';

/**
 * The writes behind a leave (Phase 2): record it, name who covers, move its
 * dates, cancel it. Each is one `guarded` transaction, so the calendar row and
 * the audit row commit or roll back with the leave (hard rule 4, P0-7, P0-9).
 *
 * Its own file, and not `leave.ts`: `permissions.ts` imports that one, and a
 * guard or database import there is a cycle through every request.
 *
 * What these functions refuse, the database mostly refuses a second time —
 * `leave_no_overlap`, the CHECKs, the coverage trigger. The checks here exist
 * for the sentence a person sees instead of a constraint name, and for the
 * rules only application code can decide, because only it knows today.
 */

const dbDate = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const localDate = (d: Date): LocalDate => d.toISOString().slice(0, 10);

/** `leave_no_overlap` decides, not a pre-check: two admins booking the same weeks is a race a read would lose. */
function overlapAsConflict(e: unknown): unknown {
  const text = e instanceof Error ? `${e.message}${JSON.stringify((e as { meta?: unknown }).meta ?? '')}` : '';
  return text.includes('leave_no_overlap')
    ? new Conflict('This person already has a leave on some of those days', 'leave_overlaps')
    : e;
}

async function leaveRow(leaveId: string, clock: Clock) {
  const row = await prisma.leave.findUnique({ where: { id: leaveId } });
  if (!row) throw new NotFound('Leave');
  const today = localDateOf(clock.now());
  const dates = { fromDate: localDate(row.fromDate), toDate: localDate(row.toDate), cancelledAt: row.cancelledAt };
  return { ...row, ...dates, today, phase: leavePhase(dates, today) };
}

/** P0-2: an ended leave is the record of who could read what, and on which days. */
function assertNotFrozen(leave: { phase: string }) {
  if (leave.phase === 'ended' || leave.phase === 'cancelled') {
    throw new Conflict('A leave that has ended or been cancelled does not change', 'leave_frozen');
  }
}

/**
 * Which of these people could not cover the rest of a leave (D-13, P0-8)?
 *
 * Asked of the matrix, never of a role name: somebody who could write a note
 * for a client of their own, and whose notes need nobody's countersignature —
 * an associate's supervisor has no read on a covered client and would sign
 * blind. Then here for the window: active, not the person away, not leaving
 * before it ends, and not away themselves on any day still to come.
 *
 * One question with two askers. `assertCoverer` asks it of one person at the
 * door. The plan screen asks it of every coverer the leave names, on every
 * read, because Dev booking their own week off later is Dev's fact to record,
 * not Nour's leave's to refuse — and of everybody, for the pickers.
 */
async function unavailableCoverers(
  db: Tx | typeof prisma,
  leave: { userId: string; fromDate: LocalDate; toDate: LocalDate },
  ids: readonly string[],
  today: LocalDate,
): Promise<string[]> {
  const unique = [...new Set(ids)];
  const from = leave.fromDate > today ? leave.fromDate : today;
  const [users, departing, away] = await Promise.all([
    db.user.findMany({ where: { id: { in: unique } }, select: { id: true, role: true, active: true } }),
    db.departure.findMany({
      where: { userId: { in: unique }, status: 'planned', lastDayOn: { lt: dbDate(leave.toDate) } }, select: { userId: true },
    }),
    db.leave.findMany({
      where: {
        userId: { in: unique }, cancelledAt: null,
        fromDate: { lte: dbDate(leave.toDate) }, toDate: { gte: dbDate(from) },
      },
      select: { userId: true },
    }),
  ]);
  const able = new Set(
    users.filter((u) => u.active && u.id !== leave.userId && mayTreat(u) && !requiresCoSignature(u.role)).map((u) => u.id),
  );
  for (const { userId } of [...departing, ...away]) able.delete(userId);
  return unique.filter((id) => !able.has(id));
}

async function assertCoverer(
  tx: Tx,
  leave: { userId: string; fromDate: LocalDate; toDate: LocalDate },
  covererId: string,
  today: LocalDate,
) {
  if ((await unavailableCoverers(tx, leave, [covererId], today)).length > 0) {
    throw new Conflict('A coverer must be a clinician who is here for the whole leave', 'coverer_unavailable');
  }
}

/**
 * Which of these people could not cover a supervisor's supervision for the
 * rest of a leave (P1-3, D-22)? Everything `unavailableCoverers` asks, and one
 * question more of the matrix: could they countersign, as `maySupervise` asks
 * of a departure's receiver. Anybody else is a co-signature nobody can give.
 */
async function unavailableSupervisors(
  db: Tx | typeof prisma,
  leave: { userId: string; fromDate: LocalDate; toDate: LocalDate },
  ids: readonly string[],
  today: LocalDate,
): Promise<string[]> {
  const unique = [...new Set(ids)];
  const [cannot, users] = await Promise.all([
    unavailableCoverers(db, leave, unique, today),
    db.user.findMany({ where: { id: { in: unique } }, select: { id: true, role: true } }),
  ]);
  const able = new Set(users.filter(maySupervise).map((u) => u.id));
  return unique.filter((id) => cannot.includes(id) || !able.has(id));
}

/**
 * The door for a supervision cover (D-22). Somebody who supervises anyone must
 * name one, so a supervisee's signed notes always have somebody at work to
 * countersign them. Somebody who supervises nobody need not.
 */
async function assertSupervisionCover(
  tx: Tx,
  leave: { userId: string; fromDate: LocalDate; toDate: LocalDate },
  coveringSupervisorId: string | null,
  today: LocalDate,
) {
  if (coveringSupervisorId === null) {
    if (await tx.user.count({ where: { supervisorId: leave.userId } })) {
      throw new Conflict('Somebody must cover their supervision while they are away', 'supervision_uncovered');
    }
    return;
  }
  if ((await unavailableSupervisors(tx, leave, [coveringSupervisorId], today)).length > 0) {
    throw new Conflict('Supervision must be covered by a supervisor who is here for the whole leave', 'supervision_cover_unavailable');
  }
}

/**
 * Record a leave, its coverer and its calendar row, in one transaction.
 *
 * Admin alone (`leave.create`), because creating closes the books for the
 * window (P0-6). Never backdated: the row is the record of which days a
 * colleague could read this caseload, and a leave written today that starts
 * last week claims reads that nobody could have made.
 */
export async function createLeave(
  actor: Actor,
  input: {
    userId: string; fromDate: LocalDate; toDate: LocalDate; coveringClinicianId: string;
    coveringSupervisorId?: string | null;
  },
  clock: Clock = systemClock,
) {
  const today = localDateOf(clock.now());
  if (input.fromDate < today) throw new Conflict('A leave cannot start before today', 'leave_starts_past');
  if (input.toDate < input.fromDate) throw new Conflict('A leave cannot end before it starts', 'leave_ends_before_start');

  // Decided here, as `planDeparture` does: the audit row names the leave.
  const id = randomUUID();
  try {
    return await guarded(
      { actor, action: 'create', resource: 'leave', resourceId: id, target: { subjectUserId: input.userId } },
      async (tx) => {
        await assertCoverer(tx, input, input.coveringClinicianId, today);
        await assertSupervisionCover(tx, input, input.coveringSupervisorId ?? null, today);
        const override = await tx.availabilityOverride.create({
          // D-12: the calendar is read by front desk, so the reason is the word and nothing more.
          data: { userId: input.userId, fromDate: dbDate(input.fromDate), toDate: dbDate(input.toDate), reason: 'Leave' },
        });
        const leave = await tx.leave.create({
          data: {
            id, userId: input.userId,
            fromDate: dbDate(input.fromDate), toDate: dbDate(input.toDate),
            coveringClinicianId: input.coveringClinicianId, plannedById: actor.id, overrideId: override.id,
            coveringSupervisorId: input.coveringSupervisorId ?? null,
          },
        });
        // A leave that starts today is on the moment it commits.
        await settleAlerts(tx, actor, leave, today);
        return leave;
      },
    );
  } catch (e) {
    throw overlapAsConflict(e);
  }
}

/**
 * Change who covers the leave as a whole.
 *
 * Any per-client row that already named the new coverer now says "same as the
 * leave", and there is no row for that, so it goes in the same transaction.
 */
export async function nameCoverer(actor: Actor, leaveId: string, coveringClinicianId: string, clock: Clock = systemClock) {
  const leave = await leaveRow(leaveId, clock);
  assertNotFrozen(leave);

  return guarded(
    {
      actor, action: 'update', resource: 'leave', resourceId: leaveId,
      target: { subjectUserId: leave.userId }, reason: 'leave:coverer_named',
    },
    async (tx) => {
      await assertCoverer(tx, leave, coveringClinicianId, leave.today);
      await tx.leaveCoverage.deleteMany({ where: { leaveId, coveringClinicianId } });
      const named = await tx.leave.update({ where: { id: leaveId }, data: { coveringClinicianId } });
      await settleAlerts(tx, actor, leave, leave.today);
      return named;
    },
  );
}

/**
 * Name, change or clear who covers the supervision (P1-3). On an active leave
 * this write is the grant, as a coverage decision is (D-15), and the audit row
 * is the control. Clearing it is refused while anybody is still supervised.
 * No alert moves: supervision routes none.
 */
export async function nameSupervisionCover(
  actor: Actor,
  leaveId: string,
  coveringSupervisorId: string | null,
  clock: Clock = systemClock,
) {
  const leave = await leaveRow(leaveId, clock);
  assertNotFrozen(leave);

  return guarded(
    {
      actor, action: 'update', resource: 'leave', resourceId: leaveId,
      target: { subjectUserId: leave.userId }, reason: 'leave:supervision_cover_named',
    },
    async (tx) => {
      await assertSupervisionCover(tx, leave, coveringSupervisorId, leave.today);
      return tx.leave.update({ where: { id: leaveId }, data: { coveringSupervisorId } });
    },
  );
}

/**
 * Decide who covers one client (story 2).
 *
 * On an active leave this write is the grant (D-15): the audit row, naming
 * the client and the decider, is the control. Naming the leave's own coverer
 * removes the override rather than copying the leave onto a row.
 */
export async function decideCoverage(
  actor: Actor,
  leaveId: string,
  input: { clientId: string; coveringClinicianId: string },
  clock: Clock = systemClock,
) {
  const leave = await leaveRow(leaveId, clock);
  assertNotFrozen(leave);
  const { clientId, coveringClinicianId } = input;

  return guarded(
    {
      actor, action: 'update', resource: 'leave', resourceId: leaveId, clientId,
      target: { subjectUserId: leave.userId }, reason: 'leave:coverage_decided',
    },
    async (tx) => {
      if (!(await tx.client.count({ where: { id: clientId, treatingClinicianId: leave.userId, status: 'active' } }))) {
        throw new Conflict('That client is not on this caseload', 'not_on_caseload');
      }
      let row = null;
      if (coveringClinicianId === leave.coveringClinicianId) {
        await tx.leaveCoverage.deleteMany({ where: { leaveId, clientId } });
      } else {
        await assertCoverer(tx, leave, coveringClinicianId, leave.today);
        const decision = { coveringClinicianId, decidedById: actor.id, decidedAt: clock.now() };
        row = await tx.leaveCoverage.upsert({
          where: { leaveId_clientId: { leaveId, clientId } },
          create: { leaveId, clientId, ...decision },
          update: decision,
        });
      }
      await settleAlerts(tx, actor, leave, leave.today);
      return row;
    },
  );
}

/**
 * Move a leave's dates, and its calendar row with them.
 *
 * Upcoming: any dates from today on. Active: the first day has happened and
 * stays; the last day may extend, and `leave_no_overlap` decides the
 * extension, or shorten as far as yesterday. That is "back today" (D-10,
 * D-18): the leave has ended when this commits, so the coverer's next read is
 * refused and the alerts the leave moved go back in this transaction (P0-5).
 * Extending an active leave widens a grant, like a coverage decision, and is
 * audited the same way. An upcoming leave moved to start today is on when this
 * commits, and its alerts go to the coverer here too (D-19).
 */
export async function editLeaveDates(
  actor: Actor,
  leaveId: string,
  input: { fromDate: LocalDate; toDate: LocalDate },
  clock: Clock = systemClock,
) {
  const leave = await leaveRow(leaveId, clock);
  assertNotFrozen(leave);
  const { fromDate, toDate } = input;
  if (leave.phase === 'active' && fromDate !== leave.fromDate) {
    throw new Conflict('A leave under way keeps its first day', 'leave_started');
  }
  if (leave.phase === 'upcoming' && fromDate < leave.today) {
    throw new Conflict('A leave cannot start before today', 'leave_starts_past');
  }
  if (toDate < addDays(leave.today, -1)) {
    throw new Conflict('A leave can end yesterday at the earliest, for somebody back today', 'leave_ends_past');
  }
  if (toDate < fromDate) throw new Conflict('A leave cannot end before it starts', 'leave_ends_before_start');

  try {
    return await guarded(
      {
        actor, action: 'update', resource: 'leave', resourceId: leaveId,
        target: { subjectUserId: leave.userId }, reason: 'leave:dates_edited',
      },
      async (tx) => {
        const dates = { fromDate: dbDate(fromDate), toDate: dbDate(toDate) };
        await tx.availabilityOverride.update({ where: { id: leave.overrideId! }, data: dates });
        const edited = await tx.leave.update({ where: { id: leaveId }, data: dates });
        await settleAlerts(tx, actor, leave, leave.today);
        return edited;
      },
    );
  } catch (e) {
    throw overlapAsConflict(e);
  }
}

/** `upcoming → cancelled`, the one stored transition; the calendar row goes with it. */
export async function cancelLeave(actor: Actor, leaveId: string, clock: Clock = systemClock) {
  const leave = await leaveRow(leaveId, clock);
  if (!canTransition(leave.phase, 'cancelled')) {
    throw new Conflict(`A leave that is ${leave.phase} cannot be cancelled`, 'bad_transition');
  }

  return guarded(
    {
      actor, action: 'update', resource: 'leave', resourceId: leaveId,
      target: { subjectUserId: leave.userId }, reason: 'leave:cancelled',
    },
    async (tx) => {
      // The link first: `Restrict` refuses the calendar row's deletion while a leave names it.
      const cancelled = await tx.leave.update({
        where: { id: leaveId }, data: { cancelledAt: clock.now(), overrideId: null },
      });
      await tx.availabilityOverride.delete({ where: { id: leave.overrideId! } });
      return cancelled;
    },
  );
}

const ALERT_ROW = {
  id: true, clientId: true, recipientId: true, coveringLeaveId: true,
  client: { select: { treatingClinicianId: true } },
} as const;

/** Alerts about this person's own clients still addressed to them: what a leave moves on its first day. */
const waitingWith = (userId: string) => ({ coveringLeaveId: null, recipientId: userId, client: { treatingClinicianId: userId } });

type AlertRow = {
  id: string; clientId: string; recipientId: string; coveringLeaveId: string | null;
  client: { treatingClinicianId: string };
};

/**
 * Put each alert where routing says it belongs today, in the caller's
 * transaction: the sweep's, or an early return's.
 *
 * Each write is conditioned on the alert still being unread with the same
 * recipient, so an acknowledgement that lands mid-run stays where it was read.
 * Acknowledged alerts never move: "Dev saw this on 14 October" is a fact about
 * 14 October.
 */
async function rerouteAlerts(tx: Tx, actor: Actor, alerts: readonly AlertRow[], today: LocalDate) {
  const coverage = await coverageOf(
    tx, alerts.map((a) => ({ id: a.clientId, treatingClinicianId: a.client.treatingClinicianId })), today,
  );
  const moved: string[] = [];
  for (const a of alerts) {
    const to = routeOf(a.client, coverage.get(a.clientId), today);
    if (to.recipientId === a.recipientId && to.coveringLeaveId === a.coveringLeaveId) continue;
    const { count } = await tx.alert.updateMany({
      where: { id: a.id, recipientId: a.recipientId, acknowledgedAt: null }, data: to,
    });
    if (!count) continue;
    // P0-9: ids and a code. The leave is the one the alert moved under, or back from.
    await auditEvent(actor, 'update', 'leave', {
      resourceId: to.coveringLeaveId ?? a.coveringLeaveId!, clientId: a.clientId,
      reason: to.coveringLeaveId ? 'leave:alert_to_coverer' : 'leave:alert_returned',
    }, tx);
    moved.push(a.id);
  }
  return moved;
}

/**
 * Put this leave's unread alerts where routing says they belong today, in the
 * write that changed the answer (D-19): a leave starting today, a coverer named
 * or a client split mid-leave, an early return.
 *
 * Without it the alert waited for the next sweep with somebody the matrix had
 * already stopped reading the record behind it. Idempotent like the sweep, so
 * a write that changes nobody's reader moves nothing.
 */
async function settleAlerts(tx: Tx, actor: Actor, leave: { id: string; userId: string }, today: LocalDate) {
  const alerts = await tx.alert.findMany({
    where: {
      acknowledgedAt: null,
      OR: [{ coveringLeaveId: leave.id }, waitingWith(leave.userId)],
    },
    select: ALERT_ROW,
  });
  return rerouteAlerts(tx, actor, alerts, today);
}

/**
 * The boundary sweep (P0-5, D-06): every unread alert a leave touches ends up
 * with whoever `alertRecipient` would choose today.
 *
 * Two kinds of alert are in play: one addressed to its client's treating
 * clinician while that clinician has a leave not yet over, and one a leave
 * already moved. Each goes where routing says now — to the coverer from the
 * first day, to a newly decided coverer mid-leave, back to the treating
 * clinician after the last.
 *
 * Idempotent: an alert already where it belongs is not written, so a second
 * run writes nothing and a missed run costs only lateness. Access never waits
 * on this — an alert raised in the window was routed when it was raised.
 */
export async function runLeaveAlertSweep(clock: Clock = systemClock) {
  const today = localDateOf(clock.now());
  const candidates = await prisma.alert.findMany({
    where: {
      acknowledgedAt: null,
      OR: [
        { coveringLeaveId: { not: null } },
        { recipient: { leaves: { some: { cancelledAt: null, toDate: { gte: dbDate(today) } } } } },
      ],
    },
    select: ALERT_ROW,
  });
  // An unstamped alert is the leave's only while it sits with the treating
  // clinician. One a departure passed to a supervisor is not.
  const inPlay = candidates.filter((a) => a.coveringLeaveId !== null || a.recipientId === a.client.treatingClinicianId);
  if (inPlay.length === 0) return [];
  return prisma.$transaction((tx) => rerouteAlerts(tx as Tx, SYSTEM_ACTOR, inPlay, today));
}

// ─────────────────────── the plan screen (Phase 4) ───────────────────────

/**
 * Front desk's view (story 1): who is away or about to be, until when, and
 * who covers. Names and dates, never a reason, because there is none (D-12).
 *
 * Not yet over and not cancelled. An ended leave is the audit log's to tell.
 */
export async function listLeaves(actor: Actor, clock: Clock = systemClock) {
  const today = localDateOf(clock.now());
  return guarded({ actor, action: 'read', resource: 'leave' }, async (tx) => {
    const rows = await tx.leave.findMany({
      where: { cancelledAt: null, toDate: { gte: dbDate(today) } },
      select: {
        id: true, fromDate: true, toDate: true,
        user: { select: { name: true } }, coveringClinician: { select: { name: true } },
        _count: { select: { coverage: true } },
      },
      orderBy: { fromDate: 'asc' },
    });
    return rows.map((r) => {
      const dates = { fromDate: localDate(r.fromDate), toDate: localDate(r.toDate) };
      return { ...r, ...dates, phase: leavePhase(dates, today) };
    });
  });
}

/**
 * P1-5: the leave section of `/worklists`, in counts (departure D-25, D-28).
 *
 * The plan screen is where clients are named; this says which plan to open.
 * Per leave not yet over: the caseload its coverers take on, which is the
 * overload this PRD leaves a practice to judge; how many named coverers could
 * not cover the rest of it, by the plan screen's own scan; and the unread
 * alerts still with the person away. On an upcoming leave those move on its
 * first day. On an active one they should already have, and a number there is
 * a sweep that has not run.
 */
export async function leaveWorklist(actor: Actor, clock: Clock = systemClock) {
  const today = localDateOf(clock.now());
  return guarded({ actor, action: 'read', resource: 'leave' }, async (tx) => {
    const open = await tx.leave.findMany({
      where: { cancelledAt: null, toDate: { gte: dbDate(today) } },
      select: {
        id: true, userId: true, fromDate: true, toDate: true, coveringClinicianId: true,
        user: { select: { name: true } }, coveringClinician: { select: { name: true } },
        coverage: { select: { coveringClinicianId: true } },
      },
      orderBy: { fromDate: 'asc' },
    });
    return Promise.all(open.map(async (l) => {
      const dates = { fromDate: localDate(l.fromDate), toDate: localDate(l.toDate) };
      const named = [l.coveringClinicianId, ...l.coverage.map((c) => c.coveringClinicianId)];
      const [unavailable, clients, unreadAlerts] = await Promise.all([
        unavailableCoverers(tx, { userId: l.userId, ...dates }, named, today),
        tx.client.count({ where: { treatingClinicianId: l.userId, status: 'active' } }),
        tx.alert.count({ where: { acknowledgedAt: null, ...waitingWith(l.userId) } }),
      ]);
      return {
        id: l.id, name: l.user.name, coverer: l.coveringClinician.name, ...dates,
        phase: leavePhase({ ...dates, cancelledAt: null }, today),
        clients, unavailableCoverers: unavailable.length, unreadAlerts,
      };
    }));
  });
}

/**
 * P1-1: unread alerts addressed to somebody away today with no leave behind
 * the absence. A bare `unavailable` override grants nobody anything (D-11), so
 * each of these waits on a person who is not here. A count and never a client
 * (departure D-25), on `leave.read` like the section it sits in; the screen
 * shows it to whoever holds `leave.create`, because recording a leave is the fix.
 */
export async function uncoveredAbsenceAlerts(actor: Actor, clock: Clock = systemClock) {
  const today = dbDate(localDateOf(clock.now()));
  return guarded({ actor, action: 'read', resource: 'leave' }, (tx) =>
    tx.alert.count({
      where: {
        acknowledgedAt: null,
        recipient: {
          overrides: { some: { kind: 'unavailable', leave: { is: null }, fromDate: { lte: today }, toDate: { gte: today } } },
        },
      },
    }));
}

/**
 * The plan screen, in one read and one audit row.
 *
 * Client names ride on `leave.read`, as a departure plan's ride on
 * `departure.read`: names and codes at the demographic tier front desk already
 * reads, and nothing a coverage decision does not need. The caseload is the
 * one still treated, plus any client this leave decided about who has since
 * moved on, so a split is never silently dropped from the record.
 *
 * `unavailable` is P0-8's continuous scan: each coverer the plan names who
 * could not cover the rest of it, on today's facts. `coverers` is who the
 * pickers offer. Both are empty once the leave is frozen. The supervision
 * cover gets the same scan (P1-3): `supervisors` for its picker, and
 * `supervisionBlocked` when the one named could not, or nobody is named for
 * somebody who supervises anyone.
 */
export async function getLeavePlan(actor: Actor, leaveId: string, clock: Clock = systemClock) {
  const leave = await leaveRow(leaveId, clock);

  return guarded(
    { actor, action: 'read', resource: 'leave', resourceId: leaveId, target: { subjectUserId: leave.userId } },
    async (tx) => {
      const [detail, clients, everyone, supervisees] = await Promise.all([
        tx.leave.findUniqueOrThrow({
          where: { id: leaveId },
          select: {
            user: { select: { name: true } },
            plannedBy: { select: { name: true } },
            coveringClinician: { select: { id: true, name: true } },
            coveringSupervisor: { select: { id: true, name: true } },
          },
        }),
        tx.client.findMany({
          where: { OR: [{ treatingClinicianId: leave.userId, status: 'active' }, { leaveCoverage: { some: { leaveId } } }] },
          select: {
            id: true, code: true, firstName: true, lastName: true,
            leaveCoverage: {
              where: { leaveId },
              select: {
                coveringClinicianId: true, decidedAt: true,
                coveringClinician: { select: { name: true } }, decidedBy: { select: { name: true } },
              },
            },
          },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        }),
        tx.user.findMany({ where: { active: true }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } }),
        tx.user.count({ where: { supervisorId: leave.userId } }),
      ]);

      const live = leave.phase === 'upcoming' || leave.phase === 'active';
      const named = new Set([leave.coveringClinicianId, ...clients.flatMap((c) => c.leaveCoverage.map((r) => r.coveringClinicianId))]);
      const cannot = new Set(
        live ? await unavailableCoverers(tx, leave, [...named, ...everyone.map((u) => u.id)], leave.today) : [],
      );

      const supervisors = live ? everyone.filter((u) => !cannot.has(u.id) && maySupervise(u)) : [];
      const cover = detail.coveringSupervisor;

      return {
        ...leave,
        ...detail,
        clients: clients.map(({ leaveCoverage, ...c }) => ({ ...c, coverage: leaveCoverage[0] ?? null })),
        unavailable: [...named].filter((id) => cannot.has(id)),
        coverers: live ? everyone.filter((u) => !cannot.has(u.id)).map(({ id, name }) => ({ id, name })) : [],
        supervisees,
        supervisors: supervisors.map(({ id, name }) => ({ id, name })),
        supervisionBlocked: live && (cover ? !supervisors.some((u) => u.id === cover.id) : supervisees > 0),
      };
    },
  );
}
