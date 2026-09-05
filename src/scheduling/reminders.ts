import { guarded } from '../auth/guard';
import { SYSTEM_ACTOR } from '../auth/permissions';
import { DAY, systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { queueToClient } from '../messaging/outbox';
import { ensurePortalLink } from '../portal/service';
import {
  confirmationRequired,
  dueStages,
  stageDueAt,
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
 * Two runs racing on the same stage. The `@@unique([appointmentId, stage])` key
 * is the idempotency guarantee — the pre-filter below is only an optimisation —
 * so losing the race means the work is already done, not that anything failed.
 */
const isDuplicateStage = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';

export interface HorizonResult {
  queued: { appointmentId: string; stage: ReminderStage }[];
  /** Appointments this run promoted `not_required` → `pending`. */
  promoted: string[];
  /** Live `pending` rows returned to `not_required` because the practice may no longer ask. */
  exempted: string[];
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
      createdAt: true,
      confirmation: true,
      client: { select: { reminderPreference: true, email: true, phone: true } },
      reminders: { select: { stage: true } },
    },
    orderBy: { startAt: 'asc' },
  });

  const result: HorizonResult = { queued: [], promoted: [], exempted: [] };

  for (const appt of candidates) {
    if (!confirmationRequired(appt.client, appt, settings)) {
      // A client who switched to `none` — or lost the address their channel
      // needs — mid-cadence. The remaining stages stop here, and the live
      // `pending` goes back to `not_required` so the sweep can never turn it
      // into `no_response`. The safety setting is not allowed to become a
      // billing trap by arriving late.
      if (appt.confirmation === 'pending') {
        await guarded(auditFor(appt), (tx) =>
          tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'not_required' } }));
        result.exempted.push(appt.id);
      }
      continue;
    }

    const already = new Set(appt.reminders.map((r) => r.stage));
    const due = dueStages(appt, now, settings).filter((stage) => !already.has(stage));
    if (!due.length) continue;

    // One transaction for the whole appointment: the messages, their reminder
    // rows, the promotion and the audit row commit together or not at all.
    // Losing a race leaves the work to the run that won it.
    try {
      await guarded(auditFor(appt), async (tx) => {
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

const auditFor = (appt: { id: string; clientId: string }) => ({
  actor: SYSTEM_ACTOR,
  action: 'update' as const,
  resource: 'appointment' as const,
  resourceId: appt.id,
  clientId: appt.clientId,
});
