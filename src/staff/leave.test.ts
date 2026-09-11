import { describe, expect, it } from 'vitest';
import { addDays, localDateOf, zonedToUtc } from '../time';
import { leavePhase, type LeaveDates } from './leave';

const NOUR: LeaveDates = { fromDate: '2026-10-05', toDate: '2026-11-27' };

describe('a leave’s phase is a function of its dates and today', () => {
  it('is upcoming until the first day, and active on it', () => {
    expect(leavePhase(NOUR, '2026-10-04')).toBe('upcoming');
    expect(leavePhase(NOUR, '2026-10-05')).toBe('active');
  });

  it('is active on the last day, and ended the day after', () => {
    expect(leavePhase(NOUR, '2026-11-27')).toBe('active');
    expect(leavePhase(NOUR, '2026-11-28')).toBe('ended');
  });

  it('a one-day leave is active on exactly that day', () => {
    const day: LeaveDates = { fromDate: '2026-10-05', toDate: '2026-10-05' };
    expect(leavePhase(day, '2026-10-04')).toBe('upcoming');
    expect(leavePhase(day, '2026-10-05')).toBe('active');
    expect(leavePhase(day, '2026-10-06')).toBe('ended');
  });

  it('compares dates, not strings that happen to sort, across a month and a year', () => {
    const winter: LeaveDates = { fromDate: '2026-12-28', toDate: '2027-01-08' };
    expect(leavePhase(winter, '2026-12-31')).toBe('active');
    expect(leavePhase(winter, '2027-01-01')).toBe('active');
    expect(leavePhase(winter, addDays('2027-01-08', 1))).toBe('ended');
  });

  it('an early return is an edit to toDate, and the phase follows it', () => {
    const back = { ...NOUR, toDate: '2026-10-20' };
    expect(leavePhase(back, '2026-10-20')).toBe('active');
    expect(leavePhase(back, '2026-10-21')).toBe('ended');
  });

  it('cancelled wins on every day, inside the window included', () => {
    const off = { ...NOUR, cancelledAt: new Date('2026-09-20T15:00:00Z') };
    for (const day of ['2026-10-04', '2026-10-05', '2026-11-01', '2026-11-27', '2026-11-28']) {
      expect(leavePhase(off, day), day).toBe('cancelled');
    }
  });

  it('midnight is the boundary in the practice’s zone, not in UTC', () => {
    // 23:40 on the 27th in New York is already the 28th in UTC.
    const lateOnTheLastDay = zonedToUtc('2026-11-27', 23 * 60 + 40);
    const justAfterMidnight = zonedToUtc('2026-11-28', 10);
    expect(lateOnTheLastDay.toISOString().slice(0, 10)).toBe('2026-11-28');
    expect(leavePhase(NOUR, localDateOf(lateOnTheLastDay))).toBe('active');
    expect(leavePhase(NOUR, localDateOf(justAfterMidnight))).toBe('ended');
  });
});
