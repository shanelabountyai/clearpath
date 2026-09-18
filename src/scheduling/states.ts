// The session state machine's pure half, with no database import, so a client
// component can read it (primitives.tsx -> CHARGEABLE). lifecycle.ts re-exports
// all of it; transitions still run through lifecycle (hard rule 8).

export type Status =
  | 'scheduled' | 'confirmed' | 'arrived' | 'in_session'
  | 'completed' | 'no_show' | 'cancelled' | 'late_cancelled';

/**
 * The session lifecycle, in one place.
 *
 * Terminal states are terminal: a completed session is not re-opened and a
 * cancellation is not un-cancelled, because both carry money and both are
 * already in the audit log. The correction for a wrong status is a new
 * appointment, the same way the correction for a signed note is an amendment.
 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'late_cancelled', 'no_show'],
  confirmed: ['arrived', 'cancelled', 'late_cancelled', 'no_show'],
  arrived: ['in_session', 'no_show'],
  in_session: ['completed'],
  completed: [],
  no_show: [],
  cancelled: [],
  late_cancelled: [],
};

export const canTransition = (from: Status, to: Status): boolean =>
  TRANSITIONS[from].includes(to);

/** Statuses that count against a client's attendance record. */
export const CHARGEABLE: readonly Status[] = ['no_show', 'late_cancelled'];
