import { addDays, daysBetween, weekdayOf, type LocalDate } from '../time';

/**
 * Standing weekly sessions are the backbone of a counseling practice, so the
 * recurrence engine has one job it must never get wrong: running it twice must
 * not produce two appointments.
 *
 * Idempotency comes from an occurrence key — series id plus the local date —
 * carried on the appointment row under a unique index. A second horizon run
 * sees the key and skips. A *rescheduled* instance keeps its key, so detaching
 * it from the pattern does not free the slot for the engine to refill.
 */

type Frequency = 'weekly' | 'biweekly';

export interface Pattern {
  frequency: Frequency;
  /** 0 = Sunday. */
  weekday: number;
  startDate: LocalDate;
  endDate?: LocalDate | null;
}

interface Window {
  from: LocalDate;
  to: LocalDate;
}

/** The first date on or after `startDate` that falls on the pattern's weekday. */
export function anchorOf(pattern: Pattern): LocalDate {
  const shift = (pattern.weekday - weekdayOf(pattern.startDate) + 7) % 7;
  return addDays(pattern.startDate, shift);
}

/**
 * Every occurrence date inside the window.
 *
 * Biweekly parity is counted from the anchor, not from the window, so asking
 * for a different range never shifts which weeks the client has.
 */
export function occurrenceDates(pattern: Pattern, window: Window): LocalDate[] {
  const step = pattern.frequency === 'biweekly' ? 14 : 7;
  const anchor = anchorOf(pattern);
  const dates: LocalDate[] = [];

  // Jump straight to the first occurrence at or after the window start.
  const gap = daysBetween(anchor, window.from);
  const skip = gap <= 0 ? 0 : Math.ceil(gap / step);
  let cursor = addDays(anchor, skip * step);

  const last = pattern.endDate && pattern.endDate < window.to ? pattern.endDate : window.to;
  while (cursor <= last) {
    dates.push(cursor);
    cursor = addDays(cursor, step);
  }
  return dates;
}

export const occurrenceKey = (seriesId: string, date: LocalDate) => `${seriesId}:${date}`;

/** An instance already on the calendar, as far as the planner cares. */
export interface ExistingInstance {
  id: string;
  /**
   * The slot in the series this instance fills — the date the pattern produced,
   * which never changes. Distinct from `date`, which is where the appointment
   * actually sits now.
   *
   * Keying idempotency on `date` is the bug that looks correct until someone
   * reschedules: the instance moves to Thursday, its original Tuesday looks
   * unfilled, and the next horizon run helpfully books over the slot the client
   * just moved out of.
   */
  occurrenceDate: LocalDate;
  date: LocalDate;
  startMinute: number;
  /** A rescheduled instance: keeps its slot in the series, follows it no further. */
  detached: boolean;
  status: string;
}

/** Statuses that have not yet begun, and so may still be rewritten by an edit. */
const UNSTARTED = new Set(['scheduled', 'confirmed']);

export interface Plan {
  /** Dates with no instance yet. */
  create: LocalDate[];
  /**
   * Instances that no longer match the pattern and can still be withdrawn:
   * future, not started, not detached. Everything else is history.
   */
  obsolete: ExistingInstance[];
}

/**
 * What a horizon run — or an edit to the pattern — should do.
 *
 * `from` is the boundary between history and future. Nothing at or before it is
 * ever created or withdrawn, which is what keeps an edit today from rewriting
 * last month's sessions.
 */
export function planOccurrences(
  pattern: Pattern,
  existing: ExistingInstance[],
  window: Window,
  opts: { startMinute?: number; active?: boolean } = {},
): Plan {
  const active = opts.active ?? true;
  const wanted = active ? occurrenceDates(pattern, window) : [];
  const wantedSet = new Set(wanted);
  const taken = new Set(existing.map((e) => e.occurrenceDate));

  const stillMatches = (e: ExistingInstance) =>
    wantedSet.has(e.date) && (opts.startMinute === undefined || e.startMinute === opts.startMinute);

  return {
    create: wanted.filter((d) => !taken.has(d)),
    obsolete: existing.filter(
      (e) => e.date >= window.from && !e.detached && UNSTARTED.has(e.status) && !stillMatches(e),
    ),
  };
}

export const DURATION_MINUTES = { intake: 75, standard: 50, extended: 80 } as const;
export type AppointmentType = keyof typeof DURATION_MINUTES;
