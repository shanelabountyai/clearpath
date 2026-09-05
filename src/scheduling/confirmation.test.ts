import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../clock';
import {
  cadenceCapped,
  confirmationRequired,
  dueStages,
  stageDueAt,
  STAGES,
  type Confirmation,
  type ConfirmationSettings,
  type ReminderStage,
} from './confirmation';

const SETTINGS: ConfirmationSettings = { graceMinutes: 20, dayOfLeadHours: 3 };

/** 2026-09-01 15:00 America/New_York, as everywhere else in this suite. */
const START = new Date('2026-09-01T19:00:00Z');
const bookedAt = (msBeforeStart: number) => new Date(START.getTime() - msBeforeStart);

const client = (over: Partial<Parameters<typeof confirmationRequired>[0]> = {}) => ({
  reminderPreference: 'email' as const,
  email: 'tc-001@example.test',
  phone: '555-0100',
  ...over,
});

const appt = (msBeforeStart = 30 * DAY) => ({ startAt: START, createdAt: bookedAt(msBeforeStart) });

describe('confirmationRequired — the practice must have actually asked', () => {
  it('asks a reachable client booked with notice', () => {
    expect(confirmationRequired(client(), appt(), SETTINGS)).toBe(true);
    expect(confirmationRequired(client({ reminderPreference: 'sms' }), appt(), SETTINGS)).toBe(true);
  });

  /**
   * The denial the whole feature is judged on. `none` exists because a message
   * on a phone somebody else picks up is a danger for some clients; billing
   * them for not answering it would turn the safety setting into a penalty for
   * needing it.
   */
  it('never asks a client on reminderPreference "none", however reachable', () => {
    expect(confirmationRequired(client({ reminderPreference: 'none' }), appt(), SETTINGS)).toBe(false);
    // Both addresses on file, booked a month out, nothing else wrong with it.
    expect(
      confirmationRequired(
        client({ reminderPreference: 'none', email: 'a@example.test', phone: '555-0100' }),
        appt(90 * DAY),
        SETTINGS,
      ),
    ).toBe(false);
  });

  it.each([
    ['email', { email: null }],
    ['sms', { phone: null }],
    ['email', { email: '' }],
    ['sms', { phone: '' }],
  ] as const)('does not ask on %s with no address on file', (pref, over) => {
    expect(confirmationRequired(client({ reminderPreference: pref, ...over }), appt(), SETTINGS)).toBe(false);
  });

  it('ignores the address it is not going to use', () => {
    expect(confirmationRequired(client({ reminderPreference: 'email', phone: null }), appt(), SETTINGS)).toBe(true);
    expect(confirmationRequired(client({ reminderPreference: 'sms', email: null }), appt(), SETTINGS)).toBe(true);
  });

  it('does not ask when the booking left no time to ask', () => {
    expect(confirmationRequired(client(), appt(19 * 60_000), SETTINGS)).toBe(false);
    // Exactly the grace window is enough notice; below it is not.
    expect(confirmationRequired(client(), appt(20 * 60_000), SETTINGS)).toBe(true);
  });

  it('reads the grace window from settings rather than a constant', () => {
    const strict: ConfirmationSettings = { ...SETTINGS, graceMinutes: 24 * 60 };
    expect(confirmationRequired(client(), appt(2 * DAY), strict)).toBe(true);
    expect(confirmationRequired(client(), appt(2 * HOUR), strict)).toBe(false);
  });
});

describe('stage due times', () => {
  it.each([
    ['d5', '2026-08-27T19:00:00.000Z'],
    ['d1', '2026-08-31T19:00:00.000Z'],
    ['d0', '2026-09-01T16:00:00.000Z'],
  ] as const)('%s is derived from the start', (stage, expected) => {
    expect(stageDueAt(START, stage as ReminderStage, SETTINGS).toISOString()).toBe(expected);
  });

  it('moves the day-of stage with the configured lead', () => {
    expect(stageDueAt(START, 'd0', { ...SETTINGS, dayOfLeadHours: 12 }).toISOString())
      .toBe('2026-09-01T07:00:00.000Z');
  });

  it('is strictly ordered, so the cadence cannot arrive out of sequence', () => {
    const times = STAGES.map((s) => stageDueAt(START, s, SETTINGS).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

/**
 * P1-2. The mitigation for the risk this feature creates rather than solves:
 * ~70 standing clients x 3 messages x 52 weeks is ~11,000 messages a year, and
 * the failure mode is not cost — it is that the reminder stops being read,
 * which degrades the very signal the fee depends on.
 */
describe('cadenceCapped — the client who has earned fewer messages', () => {
  const confirmed = (n: number): Confirmation[] => Array(n).fill('confirmed');

  it('needs a full run of confirmations, not merely a majority', () => {
    expect(cadenceCapped(confirmed(4), 4)).toBe(true);
    expect(cadenceCapped(['confirmed', 'confirmed', 'no_response', 'confirmed'], 4)).toBe(false);
    expect(cadenceCapped(['confirmed', 'confirmed', 'confirmed', 'declined'], 4)).toBe(false);
  });

  it('reads only the most recent run, so an old lapse stops counting', () => {
    expect(cadenceCapped(['confirmed', 'confirmed', 'confirmed', 'confirmed', 'no_response'], 4)).toBe(true);
  });

  it('is broken by one miss, immediately', () => {
    // The newest answer is first. A single `no_response` at the head takes the
    // client back to the full cadence on the very next horizon run, which is
    // the half of the rule that matters: a client drifting out of the habit
    // gets the reminders back before the drift costs them a fee.
    expect(cadenceCapped(['no_response', ...confirmed(10)], 4)).toBe(false);
    expect(cadenceCapped(['declined', ...confirmed(10)], 4)).toBe(false);
  });

  it('waits for enough evidence rather than assuming it', () => {
    expect(cadenceCapped(confirmed(3), 4)).toBe(false);
    expect(cadenceCapped([], 4)).toBe(false);
  });

  it('is off entirely at a cap of zero', () => {
    expect(cadenceCapped(confirmed(50), 0)).toBe(false);
  });

  it('follows the configured cap', () => {
    expect(cadenceCapped(confirmed(2), 2)).toBe(true);
    expect(cadenceCapped(confirmed(2), 8)).toBe(false);
  });
});

describe('dueStages — what a horizon run at `now` should have queued', () => {
  const booked30d = appt(30 * DAY);

  it('queues nothing before the first stage is due', () => {
    expect(dueStages(booked30d, new Date(START.getTime() - 6 * DAY), SETTINGS)).toEqual([]);
  });

  it('accumulates as the clock advances', () => {
    const at = (ms: number) => dueStages(booked30d, new Date(START.getTime() - ms), SETTINGS);
    expect(at(5 * DAY)).toEqual(['d5']);
    expect(at(2 * DAY)).toEqual(['d5']);
    expect(at(DAY)).toEqual(['d5', 'd1']);
    expect(at(3 * HOUR)).toEqual(['d5', 'd1', 'd0']);
    expect(at(0)).toEqual(['d5', 'd1', 'd0']);
  });

  it('skips a stage whose moment predates the booking, permanently', () => {
    const twoDaysOut = appt(2 * DAY);
    expect(dueStages(twoDaysOut, START, SETTINGS)).toEqual(['d1', 'd0']);

    const sixHoursOut = appt(6 * HOUR);
    expect(dueStages(sixHoursOut, START, SETTINGS)).toEqual(['d0']);
  });

  /**
   * The invariant the fee rests on: booked inside the day-of lead, there is no
   * stage to queue, so the cadence never promotes the row to `pending` and
   * `no_response` stays unreachable.
   */
  it('queues nothing at all for a booking inside the day-of lead', () => {
    expect(dueStages(appt(HOUR), START, SETTINGS)).toEqual([]);
  });

  it('is a set, not a counter — running it twice asks for the same stages', () => {
    const now = new Date(START.getTime() - HOUR);
    expect(dueStages(booked30d, now, SETTINGS)).toEqual(dueStages(booked30d, now, SETTINGS));
  });

  /** P1-2 again, on the other side of the seam: what the cap actually removes. */
  describe('under the cadence cap', () => {
    const capped = { ...SETTINGS, capped: true };
    const at = (ms: number, s = capped) => dueStages(booked30d, new Date(START.getTime() - ms), s);

    it('sends the day before and nothing else', () => {
      expect(at(5 * DAY)).toEqual([]);
      expect(at(DAY)).toEqual(['d1']);
      expect(at(0)).toEqual(['d1']);
    });

    it('still leaves the client fee-eligible — one message is still asking', () => {
      // The cap is about volume, not about exemption. A capped client who says
      // nothing has still been asked, and `confirmationRequired` is untouched.
      expect(at(DAY).length).toBeGreaterThan(0);
    });

    it('asks a capped client nothing when the booking beat the one stage', () => {
      // Booked twelve hours out, the only stage the cap allows was never
      // sendable — so nothing queues, the row is never promoted, and the fee
      // stays out of reach. The cap narrows the window; it does not create a
      // charge with no message behind it.
      expect(dueStages(appt(12 * HOUR), START, capped)).toEqual([]);
    });
  });
});
