import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../clock';
import {
  describeNotice,
  fillability,
  openingSuits,
  type Opening,
  type WaitlistPreference,
} from './openings';

/** 2026-09-01 15:00 America/New_York — a Tuesday, as everywhere else here. */
const START = new Date('2026-09-01T19:00:00Z');
const TUESDAY = 2;
const THREE_PM = 15 * 60;

const opening = (over: Partial<Opening> = {}): Opening => ({
  weekday: TUESDAY,
  startMinute: THREE_PM,
  clinicianId: 'clin-a',
  clientId: 'gave-it-back',
  ...over,
});

const waiting = (over: Partial<WaitlistPreference> = {}): WaitlistPreference => ({
  clientId: 'waiting-1',
  weekdays: [],
  earliestMinute: null,
  latestMinute: null,
  treatingClinicianId: 'clin-a',
  ...over,
});

describe('openingSuits — continuity is not one preference among several', () => {
  /**
   * The denial this module is judged on. Everything else here is a scheduling
   * near-miss; this one would propose that a client see a stranger.
   */
  it('never offers another clinician’s freed hour, however well it fits', () => {
    expect(openingSuits(waiting({ treatingClinicianId: 'clin-b' }), opening())).toBe(false);
    // Perfect on every stated preference, and still no.
    expect(
      openingSuits(
        waiting({
          treatingClinicianId: 'clin-b',
          weekdays: [TUESDAY],
          earliestMinute: THREE_PM,
          latestMinute: THREE_PM,
        }),
        opening(),
      ),
    ).toBe(false);
  });

  it('offers the hour to a waiting client of the same clinician', () => {
    expect(openingSuits(waiting(), opening())).toBe(true);
  });

  it('never offers the hour back to the client who gave it up', () => {
    expect(openingSuits(waiting({ clientId: 'gave-it-back' }), opening())).toBe(false);
  });
});

describe('openingSuits — what the client actually told us', () => {
  it('treats an empty weekday list as any day', () => {
    for (let weekday = 0; weekday < 7; weekday++) {
      expect(openingSuits(waiting({ weekdays: [] }), opening({ weekday }))).toBe(true);
    }
  });

  it('honours a weekday list', () => {
    expect(openingSuits(waiting({ weekdays: [TUESDAY] }), opening())).toBe(true);
    expect(openingSuits(waiting({ weekdays: [1, 3] }), opening())).toBe(false);
  });

  it('treats null bounds as no bound', () => {
    expect(openingSuits(waiting({ earliestMinute: null, latestMinute: null }), opening({ startMinute: 0 }))).toBe(true);
    expect(openingSuits(waiting({ earliestMinute: null, latestMinute: null }), opening({ startMinute: 1439 }))).toBe(true);
  });

  it('is inclusive at both ends of the window', () => {
    const pref = waiting({ earliestMinute: 9 * 60, latestMinute: 17 * 60 });
    expect(openingSuits(pref, opening({ startMinute: 9 * 60 }))).toBe(true);
    expect(openingSuits(pref, opening({ startMinute: 17 * 60 }))).toBe(true);
    expect(openingSuits(pref, opening({ startMinute: 9 * 60 - 1 }))).toBe(false);
    expect(openingSuits(pref, opening({ startMinute: 17 * 60 + 1 }))).toBe(false);
  });

  /** A client who can only do mornings is not offered an afternoon. */
  it('respects a one-sided window', () => {
    expect(openingSuits(waiting({ latestMinute: 12 * 60 }), opening())).toBe(false);
    expect(openingSuits(waiting({ earliestMinute: 12 * 60 }), opening())).toBe(true);
  });
});

describe('fillability — a band on a screen, and nothing more', () => {
  it('calls a decline five days out ample', () => {
    expect(fillability(START, new Date(START.getTime() - 5 * DAY))).toBe('ample');
  });

  it('turns tight below two days and improbable below four hours', () => {
    const at = (ms: number) => fillability(START, new Date(START.getTime() - ms));
    expect(at(2 * DAY)).toBe('ample');
    expect(at(2 * DAY - 1)).toBe('tight');
    expect(at(4 * HOUR)).toBe('tight');
    expect(at(4 * HOUR - 1)).toBe('improbable');
    expect(at(0)).toBe('improbable');
  });

  /**
   * The late-cancel window is 24 hours and this boundary is deliberately not
   * there. A practice that moves its fee window has not said anything about
   * which hours are worth ringing round for.
   */
  it('does not put a boundary at the late-cancel window', () => {
    const at = (ms: number) => fillability(START, new Date(START.getTime() - ms));
    expect(at(24 * HOUR + 1)).toBe(at(24 * HOUR - 1));
  });
});

describe('describeNotice — rounds down, so it never overstates the time left', () => {
  const at = (ms: number) => describeNotice(START, new Date(START.getTime() - ms));

  it.each([
    [5 * DAY, '5 days'],
    [DAY, '1 day'],
    [2 * DAY - 1, '1 day'],
    [23 * HOUR, '23 hours'],
    [HOUR, '1 hour'],
    [2 * HOUR - 1, '1 hour'],
    [59 * 60_000, '59 minutes'],
    [60_000, '1 minute'],
  ])('reads %i ms as %s', (ms, expected) => {
    expect(at(ms)).toBe(expected);
  });

  it('never rounds a sliver up to an hour it does not have', () => {
    expect(at(1)).toBe('1 minute');
  });

  it('says now for an hour that has started', () => {
    expect(at(0)).toBe('now');
    expect(at(-HOUR)).toBe('now');
  });
});
