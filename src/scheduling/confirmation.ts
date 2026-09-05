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
  return STAGES.filter((stage) => {
    const dueAt = stageDueAt(appointment.startAt, stage, settings);
    return dueAt >= appointment.createdAt && dueAt <= now;
  });
}
