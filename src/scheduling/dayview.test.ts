import { describe, expect, it } from 'vitest';
import { groupStatus, layoutTracks, type Span } from './dayview';
import type { Status } from './lifecycle';

const span = (id: string, startMinute: number, endMinute: number): Span => ({ id, startMinute, endMinute });

/** `id → "index/of"`, which is the whole of what a chip needs to position itself. */
const at = (spans: Span[]) =>
  Object.fromEntries([...layoutTracks(spans)].map(([id, t]) => [id, `${t.index}/${t.of}`]));

describe('side-by-side layout', () => {
  it('gives a session with the hour to itself the full width', () => {
    expect(at([span('a', 600, 650), span('b', 700, 750)])).toEqual({ a: '0/1', b: '0/1' });
  });

  it('splits two telehealth sessions at the same time, and hides neither', () => {
    expect(at([span('a', 600, 650), span('b', 600, 650)])).toEqual({ a: '0/2', b: '1/2' });
  });

  it('splits three, because a lane with no room has no limit', () => {
    expect(at([span('a', 600, 650), span('b', 600, 650), span('c', 600, 650)])).toEqual({
      a: '0/3', b: '1/3', c: '2/3',
    });
  });

  it('splits a partial overlap too — a 60-minute session and one starting 20 minutes in', () => {
    expect(at([span('a', 600, 660), span('b', 620, 680)])).toEqual({ a: '0/2', b: '1/2' });
  });

  it('lets a later session reuse the track of one that has ended', () => {
    // a and b share 10:00; c starts when a is over, so it takes a's track and
    // the three of them are one cluster two tracks wide.
    expect(at([span('a', 600, 650), span('b', 600, 700), span('c', 650, 700)])).toEqual({
      a: '0/2', b: '1/2', c: '0/2',
    });
  });

  it('starts a new cluster when the hour clears, so one busy hour does not narrow the day', () => {
    expect(at([span('a', 600, 650), span('b', 600, 650), span('c', 800, 850)])).toEqual({
      a: '0/2', b: '1/2', c: '0/1',
    });
  });

  it('touching sessions do not overlap: 10:00–10:50 and 10:50–11:40 are both full width', () => {
    expect(at([span('a', 600, 650), span('b', 650, 700)])).toEqual({ a: '0/1', b: '0/1' });
  });

  it('places the same sessions the same way whatever order they arrive in', () => {
    const spans = [span('c', 620, 680), span('a', 600, 660), span('b', 600, 650)];
    expect(at(spans)).toEqual(at([...spans].reverse()));
    // …and by id when start and end are identical, so the picture cannot move
    // because the database returned two rows the other way round.
    expect(at([span('b', 600, 650), span('a', 600, 650)])).toEqual({ a: '0/2', b: '1/2' });
  });

  it('does not narrow a session because the one it touches overlaps a third', () => {
    // `a` ends exactly as `b` starts, so `a` is alone and keeps the full width,
    // while `b` and `c` genuinely overlap and share. Reading the cluster
    // boundary as `>` instead of `>=` drags `a` into `b`'s cluster and halves
    // it. Two touching sessions on their own cannot show this: `b` reuses the
    // track `a` freed, so the cluster is one track wide either way.
    expect(at([span('a', 600, 650), span('b', 650, 700), span('c', 660, 710)])).toEqual({
      a: '0/1', b: '0/2', c: '1/2',
    });
  });

  it('breaks a tie on end time before id, so the shorter of two 10:00s sits first', () => {
    // The order-invariance test above proves the picture does not depend on the
    // order the rows arrive in. It cannot prove the order chosen is the right
    // one, because both sides of that comparison sort with the same comparator:
    // one that consistently sorted by end time would satisfy it.
    expect(at([span('a', 600, 660), span('b', 600, 650), span('c', 620, 680)])).toEqual({
      b: '0/3', a: '1/3', c: '2/3',
    });
  });

  it('leaves the input alone', () => {
    const spans = [span('b', 700, 750), span('a', 600, 650)];
    layoutTracks(spans);
    expect(spans.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('the status of a group hour', () => {
  const g = (...statuses: Status[]) => groupStatus(statuses);

  it('is the shared status when everyone agrees', () => {
    expect(g('scheduled', 'scheduled', 'scheduled')).toBe('scheduled');
    expect(g('completed', 'completed')).toBe('completed');
  });

  it('is not a no-show because one attendee did not come', () => {
    expect(g('completed', 'completed', 'no_show')).toBe('completed');
  });

  it('is not a late cancel because one attendee cancelled inside the window', () => {
    expect(g('scheduled', 'late_cancelled', 'scheduled')).toBe('scheduled');
  });

  it('reads as cancelled only when the room is actually empty', () => {
    expect(g('cancelled', 'cancelled')).toBe('cancelled');
    expect(g('cancelled', 'late_cancelled', 'no_show')).toBe('no_show');
  });

  it('shows the hour as live while anyone is in the room', () => {
    expect(g('scheduled', 'in_session', 'no_show')).toBe('in_session');
    expect(g('confirmed', 'arrived')).toBe('arrived');
  });

  it('does not depend on the order the attendees arrived in', () => {
    expect(g('no_show', 'completed')).toBe(g('completed', 'no_show'));
    expect(g('cancelled', 'scheduled')).toBe(g('scheduled', 'cancelled'));
  });
});
