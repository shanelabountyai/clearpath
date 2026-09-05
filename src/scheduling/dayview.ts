import type { Status } from './lifecycle';

/**
 * How the day view arranges what the query handed it.
 *
 * Pure, because both rules here are the kind that go wrong invisibly: a chip
 * drawn on top of another chip looks like a calendar with fewer sessions in it,
 * and a group hour wearing one attendee's status looks like a fact.
 */

/** The subset of a session this file needs. Keeps the layout testable. */
export type Span = { id: string; startMinute: number; endMinute: number };

/** Where a chip sits across the width of its column. */
export type Track = { index: number; of: number };

/**
 * Side-by-side placement for sessions that share an hour.
 *
 * A room column can never need this — the exclusion constraints make two
 * bookings of one room at one time impossible — but the telehealth lane is the
 * conditional resource made visible, and its whole point is that six people can
 * be in a video session at 3pm. Drawn at `inset-x-1` they land on identical
 * pixels and the last one painted wins, so the front desk reads five sessions
 * where the practice has six, and *which* one is hidden is whatever order the
 * rows came back in.
 *
 * The algorithm is the ordinary one: sort, cut the day into clusters of
 * transitively-overlapping sessions, greedily assign each session to the first
 * track free at its start, and give every session in a cluster the same width
 * so the columns line up. Sessions that overlap nothing keep the full width.
 */
export function layoutTracks<T extends Span>(sessions: readonly T[]): Map<string, Track> {
  const ordered = [...sessions].sort(
    (a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const placed = new Map<string, Track>();
  let cluster: T[] = [];
  let clusterEnd = -Infinity;
  // Per-track end minute, reset with each cluster.
  let trackEnds: number[] = [];

  const flush = () => {
    for (const s of cluster) placed.set(s.id, { index: placed.get(s.id)!.index, of: trackEnds.length });
    cluster = [];
    trackEnds = [];
    clusterEnd = -Infinity;
  };

  for (const s of ordered) {
    // A zero-length session still occupies its start minute, so a cluster
    // breaks only when the next session starts at or after everything before
    // it has ended.
    if (s.startMinute >= clusterEnd) flush();

    let index = trackEnds.findIndex((end) => end <= s.startMinute);
    if (index === -1) {
      index = trackEnds.length;
      trackEnds.push(s.endMinute);
    } else {
      trackEnds[index] = s.endMinute;
    }
    placed.set(s.id, { index, of: 1 });
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.endMinute);
  }
  flush();

  return placed;
}

/**
 * The status of a group hour, from the statuses of the people in it.
 *
 * A group session is N appointment rows, one per attendee, each carrying its
 * own status and its own money. The chip stands for the hour, so it cannot
 * simply wear the status of whichever row sorted first: a six-person group
 * where one person no-showed would render as a no-show — hatched, red,
 * struck through, chargeable — on the days the database happened to return
 * that row first.
 *
 * The question a day view answers is "is this hour happening, and is the room
 * in use", so the most-attending status wins. A group reads as cancelled only
 * when every attendee cancelled, which is also the only case where nobody is
 * in the room.
 */
const ATTENDANCE_ORDER: readonly Status[] = [
  'in_session', 'arrived', 'confirmed', 'scheduled', 'completed', 'no_show', 'late_cancelled', 'cancelled',
];

export function groupStatus(statuses: readonly Status[]): Status {
  for (const status of ATTENDANCE_ORDER) if (statuses.includes(status)) return status;
  // Not reachable through the state machine, and not worth throwing over: an
  // unknown status is the caller's to render as it finds it.
  return statuses[0] ?? 'scheduled';
}
