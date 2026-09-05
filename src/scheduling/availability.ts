import type { LocalDate } from '../time';
import { weekdayOf } from '../time';

/** A half-open interval of minutes from local midnight: [start, end). */
export interface Span {
  startMinute: number;
  endMinute: number;
}

export const overlaps = (a: Span, b: Span) =>
  a.startMinute < b.endMinute && b.startMinute < a.endMinute;

/** Weekly working hours: the pattern a clinician keeps most weeks. */
export interface WeeklyWindow extends Span {
  weekday: number;
}

/**
 * A departure from the pattern over a date range. Vacation is the one that
 * matters: a week off against standing weekly clients is this domain's cascade,
 * because every affected client needs a human conversation, not a silent gap.
 */
export interface Override extends Partial<Span> {
  fromDate: LocalDate;
  toDate: LocalDate;
  kind: 'unavailable' | 'available';
}

const subtract = (spans: Span[], cut: Span): Span[] =>
  spans.flatMap((s) => {
    if (!overlaps(s, cut)) return [s];
    const out: Span[] = [];
    if (s.startMinute < cut.startMinute) out.push({ startMinute: s.startMinute, endMinute: cut.startMinute });
    if (cut.endMinute < s.endMinute) out.push({ startMinute: cut.endMinute, endMinute: s.endMinute });
    return out;
  });

const merge = (spans: Span[]): Span[] => {
  const sorted = [...spans].sort((a, b) => a.startMinute - b.startMinute);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, s.endMinute);
    } else if (s.endMinute > s.startMinute) {
      out.push({ ...s });
    }
  }
  return out;
};

const covers = (o: Override, date: LocalDate) => o.fromDate <= date && date <= o.toDate;

/** The clinician's working windows on one date, pattern plus overrides. */
export function workingWindows(
  weekly: WeeklyWindow[],
  overrides: Override[],
  date: LocalDate,
): Span[] {
  const weekday = weekdayOf(date);
  let windows: Span[] = weekly
    .filter((w) => w.weekday === weekday)
    .map(({ startMinute, endMinute }) => ({ startMinute, endMinute }));

  for (const o of overrides.filter((x) => covers(x, date) && x.kind === 'available')) {
    windows.push({ startMinute: o.startMinute ?? 0, endMinute: o.endMinute ?? 1440 });
  }
  windows = merge(windows);

  // Unavailability wins over availability: a vacation day beats an extra shift
  // someone added and forgot about.
  for (const o of overrides.filter((x) => covers(x, date) && x.kind === 'unavailable')) {
    windows = subtract(windows, {
      startMinute: o.startMinute ?? 0,
      endMinute: o.endMinute ?? 1440,
    });
  }
  return merge(windows);
}

/**
 * The parts of today's pattern that overrides take away.
 *
 * `workingWindows` answers what is left, which is what booking needs. The day
 * view needs the complement, and needs it separated from the pattern itself:
 * being out from one until three is not a day off, and a screen that rounds it
 * up to one is lying about the other six hours. Empty when nothing is lost, the
 * whole pattern when the clinician is out for the day, and — the case that
 * makes it usable in a banner — empty for someone who simply does not work this
 * weekday, because not working Tuesdays is not an absence anybody needs told.
 */
export function lostWindows(
  weekly: WeeklyWindow[],
  overrides: Override[],
  date: LocalDate,
): Span[] {
  const weekday = weekdayOf(date);
  const pattern = merge(
    weekly
      .filter((w) => w.weekday === weekday)
      .map(({ startMinute, endMinute }) => ({ startMinute, endMinute })),
  );
  return merge(workingWindows(weekly, overrides, date).reduce(subtract, pattern));
}

export const isAway = (overrides: Override[], date: LocalDate): boolean =>
  overrides.some(
    (o) => covers(o, date) && o.kind === 'unavailable' && o.startMinute == null && o.endMinute == null,
  );

/**
 * Start times where a session of `duration` fits inside a working window and
 * collides with nothing already booked.
 *
 * The step is 15 minutes rather than the session length, because a 50-minute
 * session in a practice that also runs 75-minute intakes leaves ragged edges,
 * and front desk needs to see the 3:15 that a session-length grid would hide.
 */
export function freeSlots(opts: {
  windows: Span[];
  busy: Span[];
  duration: number;
  step?: number;
}): number[] {
  const step = opts.step ?? 15;
  const slots: number[] = [];
  for (const w of opts.windows) {
    const first = Math.ceil(w.startMinute / step) * step;
    for (let start = first; start + opts.duration <= w.endMinute; start += step) {
      const span = { startMinute: start, endMinute: start + opts.duration };
      if (!opts.busy.some((b) => overlaps(span, b))) slots.push(start);
    }
  }
  return [...new Set(slots)].sort((a, b) => a - b);
}

/**
 * The first room free for the whole span, or null when the map is full.
 *
 * Callers must not treat null as "book anyway": for an in-person session a room
 * is required, and for telehealth this function is never called at all. That
 * asymmetry is the conditional resource the whole scheduling lesson is about.
 */
export function pickRoom(
  rooms: { id: string; name: string }[],
  busyByRoom: Map<string, Span[]>,
  span: Span,
): string | null {
  for (const room of rooms) {
    const busy = busyByRoom.get(room.id) ?? [];
    if (!busy.some((b) => overlaps(span, b))) return room.id;
  }
  return null;
}
