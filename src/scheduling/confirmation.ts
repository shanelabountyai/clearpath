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
 * What a client who always answers is left with. The day-before stage, because
 * it is the one with somewhere to go: a client who confirms at `d1` has a day
 * to arrange the hour, and front desk has a day to fill it if they decline.
 * `d0` alone would be a notification, not a question.
 */
export const CAPPED_STAGES: readonly ReminderStage[] = ['d1'];

/**
 * The answers that count for or against a streak.
 *
 * `not_required` and `pending` are deliberately absent. "We never asked" is not
 * a miss and it is not a confirmation; "we asked and it is still early" is not
 * an answer yet. Only a decided appointment moves the count, in either
 * direction — which is what stops a client on `reminderPreference: 'none'`, who
 * can never confirm anything, from being permanently treated as unreliable.
 */
export const DECIDED: readonly Confirmation[] = ['confirmed', 'declined', 'no_response'];

export interface ConfirmationSettings {
  /** Notice below which there was no time to ask, and no time to answer. */
  graceMinutes: number;
  /** How far before the start the day-of stage is due. */
  dayOfLeadHours: number;
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
 * How much cadence a client has earned the right to be left alone from.
 *
 * The volume objection is the real one, and it is not about cost: ~70 recurring
 * clients × 3 messages × 52 weeks is ~11,000 messages a year, and the failure
 * mode of that is the reminder stopping being read — which degrades the very
 * signal the no-show fee is derived from. So the client who has answered four
 * times running is asked once, the day before, and nothing else.
 *
 * `recent` is most-recent-first and decided-only; the caller does that
 * filtering in SQL so this stays a function about a rule rather than about a
 * query. A cap of zero or less is the off switch, and it is off by value rather
 * than by a second flag nobody would keep in sync.
 *
 * Note what breaks a streak: one `declined` or one `no_response`, and the full
 * three stages come straight back. The cap is a reward for answering, not a
 * setting somebody has to remember to reverse.
 *
 * `chosen` is the client's own selection, and it wins outright rather than
 * intersecting with the cap. Two reductions stacked would produce silence — a
 * client who asked for the day-of nudge only, and who then answers four times
 * running, would earn a cap of `d1` that shares nothing with their `d0` and be
 * left with no message at all. That is the one outcome a preference for *fewer*
 * messages must never produce, and it would have arrived quietly, four
 * confirmations after somebody set the field.
 *
 * It is filtered through `STAGES` rather than used as given, so the order is
 * the cadence's and a duplicate or an unknown value cannot survive the trip.
 */
export function cadenceStages(
  recent: readonly Confirmation[],
  cap: number,
  chosen: readonly ReminderStage[] = [],
): readonly ReminderStage[] {
  if (chosen.length) return STAGES.filter((stage) => chosen.includes(stage));
  if (cap <= 0) return STAGES;
  let streak = 0;
  for (const answer of recent) {
    if (answer !== 'confirmed') break;
    streak += 1;
  }
  return streak >= cap ? CAPPED_STAGES : STAGES;
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
 *
 * `allowed` narrows the set the cap has left the client on. It narrows nothing
 * else: a capped client's `d1` still has to fall after the booking and before
 * now, so the cap can only ever take messages away, never move one earlier.
 */
export function dueStages(
  appointment: EligibleAppointment,
  now: Date,
  settings: ConfirmationSettings,
  allowed: readonly ReminderStage[] = STAGES,
): ReminderStage[] {
  return allowed.filter((stage) => {
    const dueAt = stageDueAt(appointment.startAt, stage, settings);
    return dueAt >= appointment.createdAt && dueAt <= now;
  });
}
