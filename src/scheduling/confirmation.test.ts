import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../clock';
import {
  confirmationRequired,
  dueStages,
  stageDueAt,
  STAGES,
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
});
