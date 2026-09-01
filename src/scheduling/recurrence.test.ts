import { describe, expect, it } from 'vitest';
import {
  anchorOf, occurrenceDates, occurrenceKey, planOccurrences,
  type ExistingInstance, type Pattern,
} from './recurrence';

const tuesdays: Pattern = { frequency: 'weekly', weekday: 2, startDate: '2026-09-01' };

describe('occurrence dates', () => {
  it('lands on the pattern weekday even when the series starts mid-week', () => {
    expect(anchorOf({ ...tuesdays, startDate: '2026-09-03' })).toBe('2026-09-08');
    expect(anchorOf(tuesdays)).toBe('2026-09-01');
  });

  it('walks weekly through the window', () => {
    expect(occurrenceDates(tuesdays, { from: '2026-09-01', to: '2026-09-29' })).toEqual([
      '2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29',
    ]);
  });

  it('walks biweekly on the anchor parity', () => {
    const p: Pattern = { ...tuesdays, frequency: 'biweekly' };
    expect(occurrenceDates(p, { from: '2026-09-01', to: '2026-10-13' })).toEqual([
      '2026-09-01', '2026-09-15', '2026-09-29', '2026-10-13',
    ]);
  });

  it('keeps biweekly parity when asked for a later window', () => {
    const p: Pattern = { ...tuesdays, frequency: 'biweekly' };
    const all = occurrenceDates(p, { from: '2026-09-01', to: '2026-12-01' });
    const later = occurrenceDates(p, { from: '2026-10-20', to: '2026-12-01' });
    expect(later.every((d) => all.includes(d))).toBe(true);
    expect(later[0]).toBe('2026-10-27');
  });

  it('stops at the series end date', () => {
    expect(occurrenceDates({ ...tuesdays, endDate: '2026-09-16' }, { from: '2026-09-01', to: '2026-12-01' }))
      .toEqual(['2026-09-01', '2026-09-08', '2026-09-15']);
  });

  it('crosses a DST boundary without losing or doubling a week', () => {
    const dates = occurrenceDates(tuesdays, { from: '2026-10-27', to: '2026-11-17' });
    expect(dates).toEqual(['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17']);
  });

  it('returns nothing when the window precedes the series', () => {
    expect(occurrenceDates(tuesdays, { from: '2026-08-01', to: '2026-08-30' })).toEqual([]);
  });
});

describe('planning a horizon run', () => {
  const window = { from: '2026-09-01', to: '2026-09-29' };
  const instance = (date: string, over: Partial<ExistingInstance> = {}): ExistingInstance =>
    ({ id: `a-${date}`, occurrenceDate: date, date, startMinute: 900, detached: false, status: 'scheduled', ...over });

  it('creates the whole horizon the first time', () => {
    const plan = planOccurrences(tuesdays, [], window, { startMinute: 900 });
    expect(plan.create).toHaveLength(5);
    expect(plan.obsolete).toEqual([]);
  });

  it('is idempotent — a second run creates nothing', () => {
    const first = planOccurrences(tuesdays, [], window, { startMinute: 900 });
    const existing = first.create.map((d) => instance(d));
    const second = planOccurrences(tuesdays, existing, window, { startMinute: 900 });
    expect(second.create).toEqual([]);
    expect(second.obsolete).toEqual([]);
  });

  it('does not regenerate a detached instance, so a reschedule stays rescheduled', () => {
    // The 8th was moved to the Thursday. It still fills the week-of-the-8th slot,
    // so the horizon run must not book a fresh Tuesday over the top of it.
    const existing = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']
      .map((d) => instance(d, d === '2026-09-08'
        ? { detached: true, date: '2026-09-10', startMinute: 600 }
        : {}));
    const plan = planOccurrences(tuesdays, existing, window, { startMinute: 900 });
    expect(plan.create).toEqual([]);
    expect(plan.obsolete).toEqual([]);
  });

  it('still fills the slot when nothing has ever occupied it', () => {
    const existing = [instance('2026-09-01')];
    const plan = planOccurrences(tuesdays, existing, window, { startMinute: 900 });
    expect(plan.create).toEqual(['2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);
  });

  it('withdraws future unstarted instances when the pattern moves', () => {
    const existing = ['2026-09-08', '2026-09-15'].map((d) => instance(d));
    const moved: Pattern = { ...tuesdays, weekday: 4 }; // Tuesdays become Thursdays
    const plan = planOccurrences(moved, existing, { from: '2026-09-08', to: '2026-09-18' }, { startMinute: 900 });
    expect(plan.obsolete.map((e) => e.date)).toEqual(['2026-09-08', '2026-09-15']);
    expect(plan.create).toEqual(['2026-09-10', '2026-09-17']);
  });

  it('withdraws an instance whose time no longer matches', () => {
    const existing = [instance('2026-09-08', { startMinute: 900 })];
    const plan = planOccurrences(tuesdays, existing, { from: '2026-09-08', to: '2026-09-08' }, { startMinute: 1020 });
    expect(plan.obsolete.map((e) => e.id)).toEqual(['a-2026-09-08']);
  });

  it('never touches history, a started session, or a detached one', () => {
    const existing = [
      instance('2026-08-25', { status: 'completed' }),
      instance('2026-09-08', { status: 'in_session' }),
      instance('2026-09-15', { detached: true }),
      instance('2026-09-22', { status: 'confirmed' }),
    ];
    const moved: Pattern = { ...tuesdays, weekday: 4 };
    const plan = planOccurrences(moved, existing, { from: '2026-09-01', to: '2026-09-25' }, { startMinute: 900 });
    expect(plan.obsolete.map((e) => e.date)).toEqual(['2026-09-22']);
  });

  it('withdraws the whole future when the series is deactivated', () => {
    const existing = ['2026-09-08', '2026-09-15'].map((d) => instance(d));
    const plan = planOccurrences(tuesdays, existing, { from: '2026-09-08', to: '2026-09-29' }, { active: false });
    expect(plan.create).toEqual([]);
    expect(plan.obsolete).toHaveLength(2);
  });
});

it('occurrence keys are stable and unique per date', () => {
  expect(occurrenceKey('s1', '2026-09-08')).toBe('s1:2026-09-08');
  expect(occurrenceKey('s1', '2026-09-08')).toBe(occurrenceKey('s1', '2026-09-08'));
  expect(occurrenceKey('s1', '2026-09-08')).not.toBe(occurrenceKey('s2', '2026-09-08'));
});
