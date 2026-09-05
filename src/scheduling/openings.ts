import { DAY, HOUR } from '../clock';

/**
 * A cancelled hour, read as something a waiting client could take.
 *
 * The confirmation loop spent five phases learning what silence means and what
 * it costs. This module is the other half of the same fact: a client who
 * declines at `d5` has not only avoided a fee, they have handed the practice
 * five days' notice of an empty hour — and five days is enough time to ring
 * somebody who has been waiting weeks for one.
 *
 * Everything here is pure and everything here is advisory. Nothing in this file
 * books anything, and that is a clinical constraint rather than a missing
 * feature: an automatic rebooking would put a client in a room with a clinician
 * neither of them chose for that hour. The output is a list of people to ring.
 */

/** The freed hour, as the match rule needs to see it. */
export interface Opening {
  /** 0 = Sunday, in practice-local time. */
  weekday: number;
  /** Minutes past practice-local midnight. */
  startMinute: number;
  /** Whose hour it was, and therefore whose hour it still is. */
  clinicianId: string;
  /** The client who gave the hour back. Never a candidate for it. */
  clientId: string;
}

/** One waiting client's stated preferences, plus the fact that outranks them. */
export interface WaitlistPreference {
  clientId: string;
  /** Empty means "any day". */
  weekdays: readonly number[];
  earliestMinute: number | null;
  latestMinute: number | null;
  /**
   * Not a preference. Every client in this system has a treating clinician, and
   * this is theirs.
   */
  treatingClinicianId: string;
}

/**
 * Whether this waiting client could be offered this hour.
 *
 * Three rules, and the order they are written in is the order they matter in.
 *
 * **Continuity first.** A freed hour belongs to the clinician who was going to
 * work it. Offering Tuesday at three to a client whose therapist is somebody
 * else is not a scheduling near-miss, it is proposing that they see a stranger
 * — and in a practice where the relationship *is* the treatment, that is the
 * one mistake this list must not make. It is checked before anything the client
 * asked for because no stated preference can override it.
 *
 * **Then the client's own window**, which is the part they actually told us:
 * the weekdays they can do and the earliest and latest they can start. An empty
 * weekday list means any day, and a null bound means no bound — a client who
 * gave us nothing is available for everything, which is the correct reading of
 * "put me on the list, I'll take what I can get".
 *
 * **And never back to the person who just gave it up.** They declined this hour
 * minutes ago. Ringing them about it reads as the practice not listening, and
 * costs nothing to prevent.
 */
export function openingSuits(pref: WaitlistPreference, opening: Opening): boolean {
  if (pref.treatingClinicianId !== opening.clinicianId) return false;
  if (pref.clientId === opening.clientId) return false;
  if (pref.weekdays.length && !pref.weekdays.includes(opening.weekday)) return false;
  if (pref.earliestMinute !== null && opening.startMinute < pref.earliestMinute) return false;
  if (pref.latestMinute !== null && opening.startMinute > pref.latestMinute) return false;
  return true;
}

/**
 * How much of a chance the practice has of filling the hour.
 *
 * A display band and an ordering, and deliberately nothing else. It carries no
 * money, it hides no opening, and no code path branches on it — front desk sees
 * every freed hour in the future, including the one two hours out that they
 * will probably not fill, because deciding on their behalf that a slot is
 * hopeless is how an hour goes quietly empty.
 *
 * The bands are not the late-cancel window and must not be folded into it. That
 * threshold decides whether a client is charged; this one decides how a row is
 * sorted on a screen. They happen to sit near each other today, and a practice
 * that raised its fee window to 48 hours would have no business changing which
 * openings look promising.
 */
export type Fillability = 'ample' | 'tight' | 'improbable';

/** Two days: time to ring several people and for one of them to move their week. */
const AMPLE_MS = 2 * DAY;
/** Four hours: fillable only by somebody whose day is already free. */
const TIGHT_MS = 4 * HOUR;

export function fillability(startAt: Date, now: Date): Fillability {
  const notice = startAt.getTime() - now.getTime();
  if (notice >= AMPLE_MS) return 'ample';
  if (notice >= TIGHT_MS) return 'tight';
  return 'improbable';
}

/**
 * Notice remaining, in the words a person ringing round would use.
 *
 * Rounds down, always. "2 days" for anything from two days to three is the
 * honest direction to be wrong in on a deadline: it never tells front desk they
 * have more time than they have.
 */
export function describeNotice(startAt: Date, now: Date): string {
  const ms = startAt.getTime() - now.getTime();
  if (ms <= 0) return 'now';
  const days = Math.floor(ms / DAY);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / HOUR);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
