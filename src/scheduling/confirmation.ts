import { DAY, HOUR } from '../clock';

/**
 * Whether the practice may ask a client to confirm, and when it would ask.
 *
 * Both halves are pure, and deliberately so: the eligibility rule is the one
 * that decides whether a client can be charged for silence, and the due-time
 * rule is what makes a five-day cadence testable in a millisecond. Neither
 * touches the database, and neither reads wall time — `now` arrives from the
 * injected clock at the call site.
 *
 * `confirmation` is a communication fact and `status` is an attendance fact.
 * They are never the same field: a client who never answered and then walked in
 * ends the day `completed` / `no_response`, and is charged the session fee like
 * anybody else.
 */

export type Confirmation =
  | 'not_required' | 'pending' | 'confirmed' | 'declined' | 'no_response';

/** 5 days out, the day before, and a fixed lead on the day itself. */
export type ReminderStage = 'd5' | 'd1' | 'd0';
export const STAGES: readonly ReminderStage[] = ['d5', 'd1', 'd0'];

/**
 * P2-3. The cadence a client asked for, as opposed to the one they earned.
 *
 * Three values, and each is a different sentence. `full` is the default and the
 * only one nobody chose. `day_before` is the single message the streak cap
 * already produces, which is why it is spelled the same way here — an earned
 * cadence and a chosen one that send the same message should not be two
 * vocabularies. `day_of` is the case the PRD names: a client who wants the
 * nudge on the morning and nothing before it.
 *
 * There is deliberately no value meaning "nothing". That is
 * `reminderPreference: 'none'`, it is a safety setting rather than a volume
 * one, and it carries a consequence this field must never acquire: a client on
 * `none` is never asked and so can never be charged for silence. A second way
 * to spell it would be a second way to reach that exemption, from a control
 * that reads like a taste in messages.
 */
export type ReminderCadence = 'full' | 'day_before' | 'day_of';

export const CADENCES: readonly ReminderCadence[] = ['full', 'day_before', 'day_of'];

export interface ConfirmationSettings {
  /** Notice below which there was no time to ask, and no time to answer. */
  graceMinutes: number;
  /** How far before the start the day-of stage is due. */
  dayOfLeadHours: number;
  /**
   * P1-2. Set for a client who has earned the shorter cadence — the day-before
   * message and nothing else. A property of the client at this moment rather
   * than of the practice, which is why it rides here instead of being a second
   * argument nobody remembers to pass.
   */
  capped?: boolean;
  /** P2-3. The cadence this client chose. Absent means nobody chose one. */
  cadence?: ReminderCadence;
}

const CADENCE_STAGES: Record<ReminderCadence, readonly ReminderStage[]> = {
  full: STAGES,
  /** Deliberately one, and deliberately the same one the cap produces. */
  day_before: ['d1'],
  day_of: ['d0'],
};

/**
 * Which stages this client gets, from what they chose and what they earned.
 *
 * **A stated preference is not overridden by an inferred one.** The cap exists
 * because volume degrades the reminder — seventy standing clients at three
 * messages a week is eleven thousand a year, and a message that stops being
 * read degrades the exact signal the fee depends on. A client who has *told*
 * the practice which message they want has already solved that problem, and
 * better than the inference can. So the cap narrows `full` and nothing else.
 *
 * The alternative — fewest messages wins — reads safer and is not implementable
 * without inventing something: a client who chose `day_of` and earned the
 * day-before cap has no stage in common, so the rule would need a tie-break
 * that no one asked for and that nobody could predict from either setting.
 */
export function stagesFor(
  cadence: ReminderCadence = 'full',
  capped = false,
): readonly ReminderStage[] {
  if (cadence !== 'full') return CADENCE_STAGES[cadence];
  return capped ? CADENCE_STAGES.day_before : STAGES;
}

/**
 * Whether a client has earned fewer messages.
 *
 * This feature's own risk, mitigated: seventy standing clients at three
 * messages a week is eleven thousand messages a year, and the failure mode is
 * not the cost. It is that the reminder stops being read — which degrades the
 * exact signal the fee depends on, so the policy would erode its own evidence
 * and then bill people for the erosion.
 *
 * `history` is the client's decided answers, newest first: `confirmed`,
 * `declined` or `no_response`. `not_required` and `pending` are not answers and
 * the caller leaves them out. A cap of zero turns the whole rule off.
 *
 * One miss restores the full cadence immediately, and that asymmetry is the
 * point: earning the quieter cadence takes four answers, losing it takes one.
 * A client drifting out of the habit gets their reminders back before the
 * drift can cost them a fee.
 */
export function cadenceCapped(history: readonly Confirmation[], cap: number): boolean {
  if (cap <= 0 || history.length < cap) return false;
  return history.slice(0, cap).every((c) => c === 'confirmed');
}

interface EligibleClient {
  reminderPreference: 'email' | 'sms' | 'none';
  email: string | null;
  phone: string | null;
}

interface EligibleAppointment {
  startAt: Date;
  /** When the appointment was booked. */
  createdAt: Date;
}

/**
 * The practice may only ask where it can actually reach the client, and only
 * where there was time to.
 *
 * `reminderPreference: 'none'` is the case this function exists for. It is a
 * safety setting — for some clients a message on a phone somebody else picks up
 * is a danger, not an inconvenience — so it means no sends, and therefore no
 * fee, structurally, rather than by hoping the cadence job never reaches them.
 * A client whose chosen channel has no address on file lands in the same place
 * for the same reason: nothing was asked.
 */
export function confirmationRequired(
  client: EligibleClient,
  appointment: EligibleAppointment,
  settings: ConfirmationSettings,
): boolean {
  if (client.reminderPreference === 'none') return false;

  const address = client.reminderPreference === 'sms' ? client.phone : client.email;
  if (!address) return false;

  const noticeMs = appointment.startAt.getTime() - appointment.createdAt.getTime();
  return noticeMs >= settings.graceMinutes * 60_000;
}

/** When a stage becomes due, derived from the start and nothing else. */
export function stageDueAt(
  startAt: Date,
  stage: ReminderStage,
  settings: ConfirmationSettings,
): Date {
  const lead =
    stage === 'd5' ? 5 * DAY : stage === 'd1' ? DAY : settings.dayOfLeadHours * HOUR;
  return new Date(startAt.getTime() - lead);
}

/**
 * The stages a horizon run at `now` should have queued.
 *
 * A stage whose moment fell before the appointment was booked is skipped
 * permanently, not queued late — booking two days out means the five-day
 * message was never a message anybody could have sent.
 *
 * A booking closer in than the day-of lead yields no stages at all. That is the
 * invariant the fee rests on: the cadence promotes `not_required` to `pending`
 * only where it actually queues something, so `no_response` is unreachable
 * without an outbox row proving the practice asked.
 */
export function dueStages(
  appointment: EligibleAppointment,
  now: Date,
  settings: ConfirmationSettings,
): ReminderStage[] {
  // The cadence — chosen or earned — narrows which stages exist for this
  // client. It does not change when they fall due, and it does not touch
  // eligibility. One message is still asking, so a client on a lighter cadence
  // who says nothing is still fee-eligible; the alternative would make the
  // lightest cadence the cheapest one, and the policy would evaporate the
  // moment anybody worked that out. A client booked inside their own last
  // stage's window gets nothing at all, which is what keeps `no_response`
  // unreachable with no message behind it.
  const stages = stagesFor(settings.cadence, settings.capped);

  return stages.filter((stage) => {
    const dueAt = stageDueAt(appointment.startAt, stage, settings);
    return dueAt >= appointment.createdAt && dueAt <= now;
  });
}
