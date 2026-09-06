import { guarded } from '../auth/guard';
import { SYSTEM_ACTOR } from '../auth/permissions';
import { DAY, systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { canRender, queueToClient } from '../messaging/outbox';
import { ensurePortalLink } from '../portal/service';
import {
  cadenceCapped,
  confirmationRequired,
  dueStages,
  stageDueAt,
  type Confirmation,
  type ConfirmationSettings,
  type ReminderStage,
} from './confirmation';

/**
 * The cadence. One entry point, driven entirely by the injected clock.
 *
 * `confirmation.ts` decides *whether* and *when*; this file is the only thing
 * that writes a row because of it. The split is what lets a five-day cadence be
 * tested in a millisecond: everything above is pure, everything here is a
 * transaction.
 *
 * Nothing sends. An `OutboxMessage` row is the stub, and it is also the
 * evidence: the fee in P0-5 reads `confirmation = 'no_response'`, and this file
 * is the only path to `pending`, which it takes **only** when a stage actually
 * queued a message. So there is no route to a charge that does not leave a row
 * proving the practice asked.
 */

/** `d5` is the furthest stage out, so nothing beyond it can be due yet. */
const MAX_LEAD_DAYS = 5;

/**
 * How far back a confirmation streak is worth reading, per session of it.
 *
 * The cap rewards a client's *current* habit, so the run has to be recent as
 * well as unbroken: three weeks apiece covers weekly and biweekly standing
 * clients with slack, and a client whose last four confirmations are older than
 * that is not a standing client with an earned cadence — they are somebody
 * coming back, and somebody coming back should get all three messages.
 *
 * It also bounds the query, which matters more every year the practice runs.
 */
const STREAK_LOOKBACK_DAYS_PER_SESSION = 21;

/** Values that are an answer. `not_required` and `pending` are not. */
const DECIDED: readonly Confirmation[] = ['confirmed', 'declined', 'no_response'];

/**
 * Each client's recent answers, newest first.
 *
 * Derived rather than counted. A `confirmationStreak` column on `Client` would
 * be one read instead of this query, and it would be a second copy of a fact
 * the appointments already hold — so a corrected row, a backfill or a
 * hand-edited status would leave the two disagreeing, silently, in the
 * direction of sending people fewer messages than they should get.
 */
async function recentAnswers(
  clientIds: string[],
  now: Date,
  cap: number,
): Promise<Map<string, Confirmation[]>> {
  const answers = new Map<string, Confirmation[]>();
  if (cap <= 0 || clientIds.length === 0) return answers;

  const rows = await prisma.appointment.findMany({
    where: {
      clientId: { in: clientIds },
      startAt: {
        lt: now,
        gte: new Date(now.getTime() - cap * STREAK_LOOKBACK_DAYS_PER_SESSION * DAY),
      },
      confirmation: { in: [...DECIDED] },
    },
    select: { clientId: true, confirmation: true },
    orderBy: { startAt: 'desc' },
  });

  for (const r of rows) {
    const seen = answers.get(r.clientId) ?? [];
    // Only the head of the run decides, so there is no reason to carry more.
    if (seen.length < cap) answers.set(r.clientId, [...seen, r.confirmation]);
  }
  return answers;
}

/**
 * One ask, identified the way the database identifies it.
 *
 * The unique key is `(appointmentId, stage, dueAt)`, so this is the pre-filter's
 * half of the same statement: a stage is "already done" for the hour it was due
 * at, and a rescheduled appointment's stages fall at new moments and are
 * therefore new questions.
 */
const askKey = (stage: ReminderStage, dueAt: Date) => `${stage}@${dueAt.getTime()}`;

/**
 * Two runs racing on the same stage. The `@@unique([appointmentId, stage,
 * dueAt])` key is the idempotency guarantee — the pre-filter above is only an
 * optimisation — so losing the race means the work is already done, not that
 * anything failed.
 */
const isDuplicateStage = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';

export interface HorizonResult {
  queued: { appointmentId: string; stage: ReminderStage }[];
  /** Appointments this run promoted `not_required` → `pending`. */
  promoted: string[];
  /** Live `pending` rows returned to `not_required` because the practice may no longer ask. */
  exempted: string[];
  /** Appointments whose client has earned the shorter cadence (P1-2). */
  capped: string[];
}

/**
 * Queue every stage that has come due and has no row yet.
 *
 * Idempotent by construction and safe to run as often as you like: re-running
 * over the same window creates no second reminder and no second outbox row.
 */
export async function runReminderHorizon(
  clock: Clock = systemClock,
  opts: { horizonDays?: number; baseUrl?: string } = {},
): Promise<HorizonResult> {
  const now = clock.now();
  const s = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const settings: ConfirmationSettings = {
    graceMinutes: s?.graceMinutes ?? 20,
    dayOfLeadHours: s?.dayOfLeadHours ?? 3,
  };
  const streakCap = s?.confirmationStreakCap ?? 4;

  const candidates = await prisma.appointment.findMany({
    where: {
      startAt: { gte: now, lte: new Date(now.getTime() + (opts.horizonDays ?? MAX_LEAD_DAYS) * DAY) },
      // An hour nobody is coming to is not asked about, and an answer already
      // given is not asked for again — confirming at `d5` means two messages
      // you do not get.
      status: { notIn: ['cancelled', 'late_cancelled'] },
      confirmation: { in: ['not_required', 'pending'] },
    },
    select: {
      id: true,
      clientId: true,
      startAt: true,
      bookedAt: true,
      confirmation: true,
      client: { select: { reminderPreference: true, reminderCadence: true, language: true, email: true, phone: true } },
      // The moment as well as the stage. Since a reschedule re-keys the
      // cadence on `dueAt`, "d1 is done" is no longer a fact about an
      // appointment — it is a fact about an appointment at an hour, and the
      // old hour's d1 must not stand in for the new one's.
      reminders: { select: { stage: true, dueAt: true } },
    },
    orderBy: { startAt: 'asc' },
  });

  // One query for the whole run rather than one per appointment: a standing
  // client has several sessions in the window and they all ask the same
  // question about the same history.
  const answers = await recentAnswers(
    [...new Set(candidates.map((a) => a.clientId))], now, streakCap,
  );

  const result: HorizonResult = { queued: [], promoted: [], exempted: [], capped: [] };

  for (const appt of candidates) {
    // A language the reminder has no body in is a client the practice cannot
    // ask, so it is decided here beside every other eligibility rule rather
    // than discovered halfway through a write. Falling back to English would
    // count an unreadable message as having asked, and the sweep would charge
    // somebody for not answering a question they could not read.
    //
    // A completeness test refuses a partially translated language outright, so
    // this branch is a safety net rather than a plan — the condition it guards
    // against is one the suite will not let anybody ship.
    const untranslated = !canRender('appointment_reminder', appt.client.language);

    if (untranslated || !confirmationRequired(appt.client, appt, settings)) {
      // A client who switched to `none` — or lost the address their channel
      // needs — mid-cadence. The remaining stages stop here, and the live
      // `pending` goes back to `not_required` so the sweep can never turn it
      // into `no_response`. The safety setting is not allowed to become a
      // billing trap by arriving late.
      if (appt.confirmation === 'pending') {
        await guarded(auditFor(appt, untranslated ? 'confirmation_untranslated' : 'confirmation_not_required'), (tx) =>
          tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'not_required' } }));
        result.exempted.push(appt.id);
      }
      continue;
    }

    // P1-2. A client who has confirmed the last `cap` times running gets the
    // day-before message and nothing else, until they miss one. Decided per
    // appointment from the client's history at this moment, so it follows them
    // rather than being a mode somebody switched on.
    const earned = cadenceCapped(answers.get(appt.clientId) ?? [], streakCap);
    // P2-3. And it applies only where nobody chose. `stagesFor` is the rule;
    // this is the same question asked again for the *report*, because a client
    // who chose `day_of` and also happens to have a streak has not been capped
    // — the cap did nothing to them, and counting them would make the number
    // mean two things.
    const capApplies = appt.client.reminderCadence === 'full' && earned;

    const already = new Set(appt.reminders.map((r) => askKey(r.stage, r.dueAt)));
    const due = dueStages(appt, now, {
      ...settings, capped: earned, cadence: appt.client.reminderCadence,
    }).filter((stage) => !already.has(askKey(stage, stageDueAt(appt.startAt, stage, settings))));
    if (!due.length) continue;
    if (capApplies) result.capped.push(appt.id);

    // One transaction for the whole appointment: the messages, their reminder
    // rows, the promotion and the audit row commit together or not at all.
    // Losing a race leaves the work to the run that won it.
    try {
      await guarded(auditFor(appt, 'reminder_queued'), async (tx) => {
        // The response the reminder asks for is a tap, so the body needs the
        // client's own door in it. Their live link, or a first one — never a
        // second token type, and never a fresh token per stage.
        const link = await ensurePortalLink(appt.clientId, clock, tx);

        for (const stage of due) {
          const message = await queueToClient({
            clientId: appt.clientId,
            templateKey: 'appointment_reminder',
            scheduledFor: now,
            startAt: appt.startAt,
            link: `${opts.baseUrl ?? 'http://localhost:3700'}/p/${link.token}`,
          }, tx);
          // Unreachable after `confirmationRequired`, and a hard stop rather
          // than a skip if it ever is: a reminder row without its outbox row
          // would be a fee with nothing behind it.
          if (!message) throw new Error(`appointment ${appt.id} passed eligibility but the outbox refused it`);

          await tx.appointmentReminder.create({
            data: {
              appointmentId: appt.id,
              stage,
              dueAt: stageDueAt(appt.startAt, stage, settings),
              // Nothing sends, so this is when the message was handed to the
              // outbox. `OutboxMessage.sentAt` stays the stub's field.
              sentAt: now,
              outboxMessageId: message.id,
            },
          });
        }

        if (appt.confirmation === 'not_required') {
          await tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'pending' } });
        }
      });
    } catch (e) {
      if (isDuplicateStage(e)) continue;
      throw e;
    }

    for (const stage of due) result.queued.push({ appointmentId: appt.id, stage });
    if (appt.confirmation === 'not_required') result.promoted.push(appt.id);
  }

  return result;
}

/**
 * P0-9. Every row this job writes carries a reason code, so the trail says what
 * happened as well as that something did — and a code is all it says. No body,
 * no address, no name, no stage-by-stage narrative.
 */
const auditFor = (appt: { id: string; clientId: string }, reason: string) => ({
  actor: SYSTEM_ACTOR,
  action: 'update' as const,
  resource: 'appointment' as const,
  resourceId: appt.id,
  clientId: appt.clientId,
  reason,
});
