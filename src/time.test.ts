import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addDays, calendarDateOf, daysBetween, localDateOf, utcToZoned, weekdayOf, zonedToUtc } from './time';

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

  it('counts them across months of different lengths', () => {
    // Both ends go through the same helper, so a constant month shift inside it
    // cancels for any pair inside one month and for any pair a whole number of
    // 31-day months apart — which is every pair the test above uses. February
    // is what separates them. This is not decoration: `occurrenceDates` divides
    // this gap by 14 to decide which fortnight a biweekly client has, so 28 read
    // as 31 moves their session by a week.
    expect(daysBetween('2026-02-15', '2026-03-15')).toBe(28);
    expect(daysBetween('2026-01-30', '2026-03-01')).toBe(30);
    expect(daysBetween('2026-01-31', '2026-03-31')).toBe(59);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('reports the local date of an instant, not the UTC one', () => {
    // 01:30 UTC on the 2nd is still the evening of the 1st in New York.
    expect(localDateOf(new Date('2026-09-02T01:30:00Z'))).toBe('2026-09-01');
  });
});

describe('a date column is not an instant', () => {
  // Postgres hands a `date` column back as midnight UTC, whatever wrote it.
  const stored = (date: string) => new Date(`${date}T00:00:00Z`);

  it('reads the date that is in the column', () => {
    expect(calendarDateOf(stored('1990-04-12'))).toBe('1990-04-12');
    expect(calendarDateOf(stored('2026-01-15'))).toBe('2026-01-15');
  });

  it('does not move it in either half of the year', () => {
    // The practice timezone is behind UTC all year, so the old reading was a
    // day early in January and a day early in July — never loudly wrong once.
    for (const date of ['2026-01-15', '2026-03-08', '2026-07-04', '2026-11-01']) {
      expect(calendarDateOf(stored(date))).toBe(date);
      expect(localDateOf(stored(date))).toBe(addDays(date, -1));
    }
  });

  it('still reads an instant as the local day it falls on', () => {
    // The two readers exist precisely because they must disagree here.
    expect(localDateOf(new Date('2026-09-02T01:30:00Z'))).toBe('2026-09-01');
    expect(calendarDateOf(new Date('2026-09-02T01:30:00Z'))).toBe('2026-09-02');
  });
});

/**
 * Which fields are calendar dates, read from the schema rather than listed.
 *
 * A list typed out here would be right on the day it was written. Deriving it
 * means a `@db.Date` column added next month is covered the day it lands —
 * the same reason the role-check and author-only rules read the tree instead
 * of a list of names.
 */
const DATE_COLUMNS = [
  ...new Set(
    [...readFileSync('prisma/schema.prisma', 'utf8').matchAll(/^\s*(\w+)\s+DateTime\??\s+@db\.Date/gm)]
      .map((m) => m[1] as string),
  ),
];

/**
 * A calendar date read through a reader meant for instants.
 *
 * Every one of these was in the codebase, and each was a day early: a client's
 * date of birth on their own record, the range a vacation covers in the
 * booking slot-finder, a recurring series' first and last day, and the
 * absence work-list. Nothing caught them because a day-early date is still a
 * plausible date — it never throws, and it is wrong in the same direction all
 * year, so no test written on a summer Tuesday reads differently in January.
 */
const READS_A_DATE_AS_AN_INSTANT = new RegExp(
  String.raw`\b(?:localDateOf|utcToZoned)\(\s*[\w.?!\[\]]*\b(?:${DATE_COLUMNS.join('|')})\b\s*,?\s*\)`,
);

it('knows which fields the schema declares as dates', () => {
  // If this ever comes back empty the lint below passes by finding nothing.
  expect(DATE_COLUMNS).toEqual(expect.arrayContaining(['dateOfBirth', 'fromDate', 'toDate', 'startDate', 'endDate']));
});

it('recognises the mistake however it is written', () => {
  const violations = [
    'localDateOf(client.dateOfBirth)',
    'fromDate: localDateOf(o.fromDate), toDate: localDateOf(o.toDate),',
    'series.endDate ? localDateOf(series.endDate) : null',
    '{localDateOf(d.absence.toDate)}',
    'utcToZoned(row.startDate)',
    'localDateOf( series.startDate )',
  ];
  expect(violations.filter((v) => !READS_A_DATE_AS_AN_INSTANT.test(v))).toEqual([]);

  // And the reads that are correct: an instant column through the instant
  // reader, and a date column through the date one.
  const allowed = [
    'localDateOf(a.startAt)',
    'localDateOf(clock.now())',
    'calendarDateOf(o.fromDate)',
    'calendarDateOf(client.dateOfBirth)',
    'utcToZoned(a.startAt).minutes',
    'startAt: { gte: zonedToUtc(input.fromDate, 0) }',
  ];
  expect(allowed.filter((v) => READS_A_DATE_AS_AN_INSTANT.test(v))).toEqual([]);
});

it('no date column is read through an instant reader', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      if (READS_A_DATE_AS_AN_INSTANT.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});
