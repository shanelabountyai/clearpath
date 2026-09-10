import { Conflict } from '../errors';

/**
 * A departure is a plan before it is an event.
 *
 * `planned` is recorded on notice and does two things immediately — closes the
 * clinician's books and marks them departing in the person picker. Everything
 * else waits for `executed`, which is a second, separate act on the last day.
 * That gap is the whole design: it is the thirty days the practice has to
 * decide fifteen dispositions and clear the hour clashes, and it is why
 * `cancelled` is cheap — withdrawing a notice reverses two flags, because
 * nothing else has happened yet.
 */
export type DepartureStatus = 'planned' | 'executed' | 'cancelled';

/**
 * Both endings are terminal, in the register `scheduling/lifecycle.ts` set.
 *
 * Nothing returns to `planned`. A departure that executed moved a caseload,
 * abandoned drafts and deactivated an account; a re-plan is a new row, the same
 * way the correction for a signed note is an amendment and not an edit. A
 * cancelled notice that is given again is genuinely a second notice, on a
 * second date, and the audit log should show two.
 */
export const TRANSITIONS: Record<DepartureStatus, readonly DepartureStatus[]> = {
  planned: ['executed', 'cancelled'],
  executed: [],
  cancelled: [],
};

export const canTransition = (from: DepartureStatus, to: DepartureStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** A wrong transition is a refusal, never a silent no-op. */
export function assertTransition(from: DepartureStatus, to: DepartureStatus): void {
  if (!canTransition(from, to)) {
    throw new Conflict(`A ${from} departure cannot become ${to}`, 'bad_transition');
  }
}
