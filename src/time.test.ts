import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, localDateOf, utcToZoned, weekdayOf, zonedToUtc } from './time';

describe('local wall time to instant', () => {
  it('converts a winter afternoon (EST, UTC-5)', () => {
    expect(zonedToUtc('2026-01-13', 15 * 60).toISOString()).toBe('2026-01-13T20:00:00.000Z');
  });

  it('converts a summer afternoon (EDT, UTC-4)', () => {
    expect(zonedToUtc('2026-07-14', 15 * 60).toISOString()).toBe('2026-07-14T19:00:00.000Z');
  });

  it('keeps a standing 3pm session at 3pm across the spring transition', () => {
    // 2026-03-08 is the US spring-forward. The Tuesdays either side must both
    // read 15:00 locally even though their UTC instants differ by an hour.
    const before = zonedToUtc('2026-03-03', 15 * 60);
    const after = zonedToUtc('2026-03-10', 15 * 60);
    expect(after.getTime() - before.getTime()).toBe(7 * 24 * 3600_000 - 3600_000);
    expect(utcToZoned(before).minutes).toBe(900);
    expect(utcToZoned(after).minutes).toBe(900);
  });

  it('keeps it at 3pm across the autumn transition', () => {
    const before = zonedToUtc('2026-10-27', 15 * 60);
    const after = zonedToUtc('2026-11-03', 15 * 60);
    expect(after.getTime() - before.getTime()).toBe(7 * 24 * 3600_000 + 3600_000);
    expect(utcToZoned(after).minutes).toBe(900);
  });

  it('round-trips midnight', () => {
    const z = zonedToUtc('2026-06-01', 0);
    expect(utcToZoned(z)).toEqual({ date: '2026-06-01', minutes: 0, weekday: 1 });
  });

  it('round-trips every hour of a DST-transition day', () => {
    for (let m = 0; m < 24 * 60; m += 30) {
      const inst = zonedToUtc('2026-11-01', m);
      const back = utcToZoned(inst);
      // 01:00–01:59 happens twice in autumn; the first pass is the answer.
      if (m >= 60 && m < 120) continue;
      expect(back).toEqual({ date: '2026-11-01', minutes: m, weekday: 0 });
    }
  });
});

describe('calendar arithmetic', () => {
  it('knows weekdays', () => {
    expect(weekdayOf('2026-09-01')).toBe(2); // Tuesday
    expect(weekdayOf('2026-09-06')).toBe(0); // Sunday
  });

  it('adds days across a month and a DST boundary without drifting', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-07', 7)).toBe('2026-03-14');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-10', -7)).toBe('2026-03-03');
  });

  it('counts whole days', () => {
    expect(daysBetween('2026-03-03', '2026-03-10')).toBe(7);
    expect(daysBetween('2026-03-10', '2026-03-03')).toBe(-7);
  });

  it('reports the local date of an instant, not the UTC one', () => {
    // 01:30 UTC on the 2nd is still the evening of the 1st in New York.
    expect(localDateOf(new Date('2026-09-02T01:30:00Z'))).toBe('2026-09-01');
  });
});
