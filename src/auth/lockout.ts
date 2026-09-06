/**
 * Failed sign-in throttling.
 *
 * The design decision worth writing down is that this expires on its own and
 * is capped, rather than locking an account until an administrator clears it.
 * A permanent lock triggered by failed attempts is a denial-of-service anybody
 * holding a staff email address can fire, and in this domain the target is a
 * clinician who cannot open a progress note before a session. The practice
 * would experience an attack on their availability as their own software
 * refusing them.
 *
 * Capping at fifteen minutes still costs a guessing run almost everything:
 * past the free attempts an attacker is down to a handful of tries an hour
 * against a twelve-character minimum. The cap bounds the *defender's* loss,
 * which a permanent lock does not, and that asymmetry is the point.
 */

/** Mistyping your own password three times is a Monday, not an attack. */
export const FREE_ATTEMPTS = 3;
const FIRST_LOCKOUT_MS = 30_000;
export const MAX_LOCKOUT_MS = 15 * 60_000;

/**
 * When this account may try again, or `null` if it may try now.
 *
 * `failedCount` is the number of consecutive failures *including* the one just
 * recorded, which is why the comparison is `>` rather than `>=`.
 */
export function lockoutUntil(failedCount: number, at: Date): Date | null {
  if (failedCount <= FREE_ATTEMPTS) return null;
  const doublings = failedCount - FREE_ATTEMPTS - 1;
  // Exponent first, so a large count cannot overflow into Infinity before the
  // cap sees it: 2 ** 20000 is Infinity, and Math.min(Infinity, cap) is cap,
  // but the multiplication would have already lost the value.
  const escalated = FIRST_LOCKOUT_MS * 2 ** Math.min(doublings, 30);
  return new Date(at.getTime() + Math.min(escalated, MAX_LOCKOUT_MS));
}

/** Milliseconds left on a lock. Zero when there is none, never negative. */
export function lockoutRemaining(until: Date | null | undefined, at: Date): number {
  if (!until) return 0;
  return Math.max(0, until.getTime() - at.getTime());
}
