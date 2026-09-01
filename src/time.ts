/**
 * Wall-clock time in the practice's timezone, and the conversion to instants.
 *
 * A standing Tuesday 3:00 PM session is 3:00 PM in March and 3:00 PM in
 * November. That means recurrence patterns are stored as *local wall time* —
 * weekday plus minutes-from-midnight — and each occurrence is converted to an
 * instant separately, so the UTC offset changes underneath the series and the
 * client's hour does not. Storing a UTC instant and adding 7 days is the
 * classic wrong answer: it silently walks the appointment an hour twice a year.
 */
export const PRACTICE_TZ = 'America/New_York';

/** 'YYYY-MM-DD' in the practice timezone. */
export type LocalDate = string;

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRACTICE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function partsOf(instant: Date) {
  const p = Object.fromEntries(
    partsFmt.formatToParts(instant).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  // 'en-CA' renders midnight as 24; normalise.
  const hour = p.hour === '24' ? '00' : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}` as LocalDate,
    hour: Number(hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Milliseconds the practice timezone is ahead of UTC at a given instant. */
function offsetAt(instant: Date): number {
  const p = partsOf(instant);
  const [y, m, d] = p.date.split('-').map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * A local date plus minutes-from-midnight, as an instant.
 *
 * Two passes: guess with the UTC offset at the naive instant, then correct with
 * the offset actually in force at the answer. That second pass is what gets the
 * hour after a DST transition right.
 */
export function zonedToUtc(date: LocalDate, minutes: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60_000;
  let instant = new Date(naive - offsetAt(new Date(naive)));
  const corrected = new Date(naive - offsetAt(instant));
  if (corrected.getTime() !== instant.getTime()) instant = corrected;
  return instant;
}

/** The local date, minutes-from-midnight and weekday (0 = Sunday) of an instant. */
export function utcToZoned(instant: Date): { date: LocalDate; minutes: number; weekday: number } {
  const p = partsOf(instant);
  return { date: p.date, minutes: p.hour * 60 + p.minute, weekday: weekdayOf(p.date) };
}

/** 0 = Sunday. Computed from the date string, so it never depends on the host. */
export function weekdayOf(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return toLocalDate(new Date(Date.UTC(y, m - 1, d + days)));
}

/** Whole days from `a` to `b`. Dates are calendar days, so this never drifts. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const day = (s: LocalDate) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((day(b) - day(a)) / 86_400_000);
}

function toLocalDate(utcMidnight: Date): LocalDate {
  return utcMidnight.toISOString().slice(0, 10);
}

/** The local date an instant falls on, in the practice timezone. */
export function localDateOf(instant: Date): LocalDate {
  return partsOf(instant).date;
}

export const minutesToHHMM = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
