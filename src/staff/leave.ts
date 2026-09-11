import type { LocalDate } from '../time';

/**
 * Where a leave stands on a given day, derived and never stored (D-02, D-10).
 *
 * The one stored fact besides the dates is `cancelledAt`. Everything else is a
 * function of the dates and the practice-local day the injected clock gives:
 * no runner sets `active` on the first morning and nothing clears it on the
 * last evening, so the last day is the last day whether or not anything ran.
 * An early return is an edit to `toDate`, never a status.
 *
 * Deliberately imports nothing that reaches the database or the guard.
 * `permissions.ts` decides coverage with this function, so a service import
 * here would be an import cycle through the one file every request passes.
 */
export type LeavePhase = 'upcoming' | 'active' | 'ended' | 'cancelled';

export interface LeaveDates {
  /** Inclusive, practice-local. */
  fromDate: LocalDate;
  /** Inclusive, practice-local. */
  toDate: LocalDate;
  cancelledAt?: Date | null;
}

/** `LocalDate` is zero-padded `YYYY-MM-DD`, so string order is date order. */
export function leavePhase(leave: LeaveDates, today: LocalDate): LeavePhase {
  if (leave.cancelledAt) return 'cancelled';
  if (today < leave.fromDate) return 'upcoming';
  if (today > leave.toDate) return 'ended';
  return 'active';
}

/**
 * The one stored transition (P0-2, hard rule 8), in the register
 * `scheduling/lifecycle.ts` set.
 *
 * Only an upcoming leave cancels. An active one has already been a grant for
 * at least a day, so it ends by shortening `toDate` to today and the record
 * keeps the days it was on. Ended and cancelled go nowhere: they are the record
 * of who could read what, and on which days.
 */
export const TRANSITIONS: Record<LeavePhase, readonly LeavePhase[]> = {
  upcoming: ['cancelled'],
  active: [],
  ended: [],
  cancelled: [],
};

export const canTransition = (from: LeavePhase, to: LeavePhase): boolean =>
  TRANSITIONS[from].includes(to);
