import { describe, expect, it } from 'vitest';
import { freeSlots, isAway, overlaps, pickRoom, workingWindows, type Override, type WeeklyWindow } from './availability';

// Tuesdays and Thursdays, 9:00–17:00.
const weekly: WeeklyWindow[] = [
  { weekday: 2, startMinute: 540, endMinute: 1020 },
  { weekday: 4, startMinute: 540, endMinute: 1020 },
];

describe('working windows', () => {
  it('follows the weekly pattern', () => {
    expect(workingWindows(weekly, [], '2026-09-01')).toEqual([{ startMinute: 540, endMinute: 1020 }]);
    expect(workingWindows(weekly, [], '2026-09-02')).toEqual([]); // Wednesday
  });

  it('clears a whole day for a vacation range', () => {
    const vacation: Override[] = [{ fromDate: '2026-09-07', toDate: '2026-09-11', kind: 'unavailable' }];
    expect(workingWindows(weekly, vacation, '2026-09-08')).toEqual([]);
    expect(workingWindows(weekly, vacation, '2026-09-10')).toEqual([]);
    expect(workingWindows(weekly, vacation, '2026-09-15')).toHaveLength(1);
    expect(isAway(vacation, '2026-09-08')).toBe(true);
    expect(isAway(vacation, '2026-09-15')).toBe(false);
  });

  it('splits a day around a partial block', () => {
    const lunch: Override[] = [
      { fromDate: '2026-09-01', toDate: '2026-09-01', kind: 'unavailable', startMinute: 720, endMinute: 780 },
    ];
    expect(workingWindows(weekly, lunch, '2026-09-01')).toEqual([
      { startMinute: 540, endMinute: 720 },
      { startMinute: 780, endMinute: 1020 },
    ]);
  });

  it('adds an extra window on a day off', () => {
    const extra: Override[] = [
      { fromDate: '2026-09-02', toDate: '2026-09-02', kind: 'available', startMinute: 600, endMinute: 720 },
    ];
    expect(workingWindows(weekly, extra, '2026-09-02')).toEqual([{ startMinute: 600, endMinute: 720 }]);
  });

  it('merges two windows that meet exactly, so a split shift reads as one', () => {
    // 9:00-12:00 and 12:00-17:00 is one working day, not two. Merging on a
    // strict `<` leaves them separate and the day reads as having a gap at noon.
    expect(workingWindows([
      { weekday: 2, startMinute: 540, endMinute: 720 },
      { weekday: 2, startMinute: 720, endMinute: 1020 },
    ], [], '2026-09-01')).toEqual([{ startMinute: 540, endMinute: 1020 }]);
  });

  it('merges a chain of three overlapping windows into one', () => {
    // Each overlaps only its neighbour, so the merge has to carry the running
    // window forward rather than compare each span against the one before it.
    expect(workingWindows([
      { weekday: 2, startMinute: 540, endMinute: 700 },
      { weekday: 2, startMinute: 660, endMinute: 800 },
      { weekday: 2, startMinute: 780, endMinute: 1020 },
    ], [], '2026-09-01')).toEqual([{ startMinute: 540, endMinute: 1020 }]);
  });

  it('ignores an extra window added to a different day', () => {
    // An evening clinic on the Thursday must not lengthen the Tuesday.
    const elsewhere: Override[] = [
      { fromDate: '2026-09-03', toDate: '2026-09-03', kind: 'available', startMinute: 1080, endMinute: 1200 },
    ];
    expect(workingWindows(weekly, elsewhere, '2026-09-01')).toEqual([{ startMinute: 540, endMinute: 1020 }]);
  });

  it('lets unavailability win over an added window', () => {
    const both: Override[] = [
      { fromDate: '2026-09-02', toDate: '2026-09-02', kind: 'available', startMinute: 600, endMinute: 720 },
      { fromDate: '2026-09-01', toDate: '2026-09-04', kind: 'unavailable' },
    ];
    expect(workingWindows(weekly, both, '2026-09-02')).toEqual([]);
  });
});

describe('free slots', () => {
  const windows = [{ startMinute: 540, endMinute: 660 }]; // 9:00–11:00

  it('steps every 15 minutes and needs room for the whole session', () => {
    expect(freeSlots({ windows, busy: [], duration: 50 })).toEqual([540, 555, 570, 585, 600]);
  });

  it('offers nothing when the session cannot fit', () => {
    expect(freeSlots({ windows: [{ startMinute: 540, endMinute: 580 }], busy: [], duration: 50 })).toEqual([]);
  });

  it('excludes anything colliding with a booking', () => {
    const busy = [{ startMinute: 570, endMinute: 620 }];
    expect(freeSlots({ windows, busy, duration: 50 })).toEqual([]);
    expect(freeSlots({ windows, busy, duration: 15 })).toEqual([540, 555, 630, 645]);
  });

  it('treats adjacent sessions as compatible — [start, end) is half-open', () => {
    expect(overlaps({ startMinute: 540, endMinute: 590 }, { startMinute: 590, endMinute: 640 })).toBe(false);
    expect(overlaps({ startMinute: 540, endMinute: 591 }, { startMinute: 590, endMinute: 640 })).toBe(true);
  });

  it('leaves a longer intake fewer openings than a standard session', () => {
    const busy = [{ startMinute: 615, endMinute: 665 }];
    const standard = freeSlots({ windows: [{ startMinute: 540, endMinute: 780 }], busy, duration: 50 });
    const intake = freeSlots({ windows: [{ startMinute: 540, endMinute: 780 }], busy, duration: 75 });
    expect(intake.length).toBeLessThan(standard.length);
  });
});

describe('room selection', () => {
  const rooms = [{ id: 'r1', name: 'A' }, { id: 'r2', name: 'B' }];
  const span = { startMinute: 900, endMinute: 950 };

  it('takes the first free room', () => {
    expect(pickRoom(rooms, new Map(), span)).toBe('r1');
    expect(pickRoom(rooms, new Map([['r1', [span]]]), span)).toBe('r2');
  });

  it('returns null when every room is taken', () => {
    const full = new Map([['r1', [span]], ['r2', [span]]]);
    expect(pickRoom(rooms, full, span)).toBeNull();
  });

  it('does not consider a room busy for an adjacent session', () => {
    const busy = new Map([['r1', [{ startMinute: 850, endMinute: 900 }]]]);
    expect(pickRoom(rooms, busy, span)).toBe('r1');
  });
});
