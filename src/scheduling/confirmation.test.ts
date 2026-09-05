import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../clock';
import {
  cadenceCapped,
  CADENCES,
  confirmationRequired,
  dueStages,
  stageDueAt,
  stagesFor,
  STAGES,
  type Confirmation,
  type ConfirmationSettings,
  type ReminderCadence,
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

describe('stagesFor — what a client chose, and what they earned', () => {
  it('gives an unchosen cadence all three stages', () => {
    expect(stagesFor()).toEqual(STAGES);
    expect(stagesFor('full', false)).toEqual(STAGES);
  });

  it('narrows a full cadence when the cap is earned', () => {
    expect(stagesFor('full', true)).toEqual(['d1']);
  });

  /**
   * The rule this function exists for. A stated preference is not overridden by
   * an inferred one: the cap is the practice guessing at what a client wants
   * from how they have behaved, and a client who said it outright has already
   * answered the question better.
   */
  it.each(['day_before', 'day_of'] as const)('leaves a chosen %s cadence alone, capped or not', (cadence) => {
    expect(stagesFor(cadence, false)).toEqual(stagesFor(cadence, true));
  });

  it('sends the chosen day-of client exactly the day-of message', () => {
    expect(stagesFor('day_of', false)).toEqual(['d0']);
    expect(stagesFor('day_of', true)).toEqual(['d0']);
  });

  /**
   * An earned cap and a chosen day-before cadence send the same message, so
   * they had better be the same list. Two vocabularies for one outcome is how a
   * report ends up with a row nobody can explain.
   */
  it('spells the earned cap and the chosen day-before cadence identically', () => {
    expect(stagesFor('full', true)).toEqual(stagesFor('day_before', false));
  });

  /**
   * There is no cadence meaning "nothing". That is `reminderPreference: 'none'`,
   * which carries an exemption from the fee — and a volume control must never
   * become a second route to it.
   */
  it('never yields an empty cadence', () => {
    for (const cadence of CADENCES) {
      for (const capped of [true, false]) {
        expect(stagesFor(cadence, capped).length).toBeGreaterThan(0);
      }
    }
  });

  it('only ever yields real stages, in the canonical order', () => {
    for (const cadence of CADENCES) {
      const stages = stagesFor(cadence, false);
      expect(stages.every((s) => STAGES.includes(s))).toBe(true);
      expect([...stages]).toEqual(STAGES.filter((s) => stages.includes(s)));
    }
  });
});

describe('dueStages — the cadence a client chose', () => {
  const withCadence = (cadence: ReminderCadence): ConfirmationSettings => ({ ...SETTINGS, cadence });

  it('queues only the day-of message for a day-of client', () => {
    // Booked a month out, asked at the moment the day-of stage falls due.
    const at = new Date(START.getTime() - SETTINGS.dayOfLeadHours * HOUR);
    expect(dueStages(appt(), at, withCadence('day_of'))).toEqual(['d0']);
    // And nothing at all five days out, where a full-cadence client gets d5.
    const fiveDaysOut = new Date(START.getTime() - 5 * DAY);
    expect(dueStages(appt(), fiveDaysOut, withCadence('day_of'))).toEqual([]);
    expect(dueStages(appt(), fiveDaysOut, SETTINGS)).toEqual(['d5']);
  });

  it('queues only the day-before message for a day-before client', () => {
    const at = new Date(START.getTime() - DAY);
    expect(dueStages(appt(), at, withCadence('day_before'))).toEqual(['d1']);
  });

  /**
   * The invariant the whole fee rests on, re-checked for a cadence that has one
   * stage instead of three: booked closer in than that client's only message,
   * nothing is ever queued — so `pending` is never written, and `no_response`
   * stays unreachable with no outbox row behind it.
   */
  it('queues nothing for a day-of client booked inside their own lead', () => {
    const bookedLate = { startAt: START, createdAt: new Date(START.getTime() - HOUR) };
    expect(dueStages(bookedLate, new Date(START.getTime() - 30 * 60_000), withCadence('day_of'))).toEqual([]);
  });

  it('does not change when a stage falls due, only which ones exist', () => {
    const justBeforeD1 = new Date(START.getTime() - DAY - 1);
    expect(dueStages(appt(), justBeforeD1, withCadence('day_before'))).toEqual([]);
    expect(dueStages(appt(), new Date(START.getTime() - DAY), withCadence('day_before'))).toEqual(['d1']);
  });

  /** A chosen cadence beats the earned cap, at the layer that queues. */
  it('gives a capped day-of client the day-of message, not the day-before one', () => {
    const at = new Date(START.getTime() - SETTINGS.dayOfLeadHours * HOUR);
    expect(dueStages(appt(), at, { ...withCadence('day_of'), capped: true })).toEqual(['d0']);
  });
});
