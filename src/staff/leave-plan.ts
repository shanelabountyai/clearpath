import { randomUUID } from 'node:crypto';
import { guarded } from '../auth/guard';
import { requiresCoSignature, type Actor } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma, type Tx } from '../db';
import { Conflict, NotFound } from '../errors';
import { localDateOf, type LocalDate } from '../time';
import { mayTreat } from './departure';
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
 * Could this person cover the rest of a leave (D-13, P0-8)?
 *
 * Asked of the matrix, never of a role name: somebody who could write a note
 * for a client of their own, and whose notes need nobody's countersignature —
 * an associate's supervisor has no read on a covered client and would sign
 * blind. Then here for the window: active, not the person away, not leaving
 * before it ends, and not away themselves on any day still to come.
 *
 * Refused at the door only. A coverer who books their own week off later is
 * recording their own fact; the plan screen scans for that (Phase 4).
 */
async function assertCoverer(
  tx: Tx,
  leave: { userId: string; fromDate: LocalDate; toDate: LocalDate; id?: string },
  covererId: string,
  today: LocalDate,
) {
  const from = leave.fromDate > today ? leave.fromDate : today;
  const u = await tx.user.findUnique({ where: { id: covererId }, select: { id: true, role: true, active: true } });
  const unavailable = !u?.active || u.id === leave.userId || !mayTreat(u) || requiresCoSignature(u.role) ||
    (await tx.departure.count({
      where: { userId: covererId, status: 'planned', lastDayOn: { lt: dbDate(leave.toDate) } },
    })) > 0 ||
    (await tx.leave.count({
      where: {
        userId: covererId, cancelledAt: null,
        fromDate: { lte: dbDate(leave.toDate) }, toDate: { gte: dbDate(from) },
      },
    })) > 0;
  if (unavailable) {
    throw new Conflict('A coverer must be a clinician who is here for the whole leave', 'coverer_unavailable');
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
  input: { userId: string; fromDate: LocalDate; toDate: LocalDate; coveringClinicianId: string },
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
        const override = await tx.availabilityOverride.create({
          // D-12: the calendar is read by front desk, so the reason is the word and nothing more.
          data: { userId: input.userId, fromDate: dbDate(input.fromDate), toDate: dbDate(input.toDate), reason: 'Leave' },
        });
        return tx.leave.create({
          data: {
            id, userId: input.userId,
            fromDate: dbDate(input.fromDate), toDate: dbDate(input.toDate),
            coveringClinicianId: input.coveringClinicianId, plannedById: actor.id, overrideId: override.id,
          },
        });
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
      return tx.leave.update({ where: { id: leaveId }, data: { coveringClinicianId } });
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
      if (coveringClinicianId === leave.coveringClinicianId) {
        await tx.leaveCoverage.deleteMany({ where: { leaveId, clientId } });
        return null;
      }
      await assertCoverer(tx, leave, coveringClinicianId, leave.today);
      const decision = { coveringClinicianId, decidedById: actor.id, decidedAt: clock.now() };
      return tx.leaveCoverage.upsert({
        where: { leaveId_clientId: { leaveId, clientId } },
        create: { leaveId, clientId, ...decision },
        update: decision,
      });
    },
  );
}

/**
 * Move a leave's dates, and its calendar row with them.
 *
 * Upcoming: any dates from today on. Active: the first day has happened and
 * stays; the last day may shorten as far as today — early return, D-10 — or
 * extend, and `leave_no_overlap` decides the extension. Extending an active
 * leave widens a grant, like a coverage decision, and is audited the same way.
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
  if (toDate < leave.today) throw new Conflict('A leave can end today at the earliest', 'leave_ends_past');
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
        return tx.leave.update({ where: { id: leaveId }, data: dates });
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
