import { guarded } from '../auth/guard';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { confirmationRequired, type ConfirmationSettings } from './confirmation';
import { setStatus } from './lifecycle';
import { SYSTEM_ACTOR } from './reminders';

/**
 * What silence means, once the session has started without an answer.
 *
 * Two functions sharing nothing, deliberately (Q6): the cadence in
 * `reminders.ts` is due before an appointment and touches no money; this one is
 * due after it started and is the only automatic path to a charge in the
 * application. Separate schedules, separate failure modes, and only one of them
 * can bill somebody.
 *
 * The whole design is D-02: `confirmation` and `status` are different facts,
 * answered by different evidence. "Did you answer my message" is recorded here
 * unconditionally, because it is the evidence. "Were you in the room" is
 * answered by whoever was at the front desk, and this sweep is only allowed to
 * guess at it where nobody has said anything at all.
 */

/** Ids, because the caller is a script and a script logs counts. */
export interface SweepResult {
  /** Every appointment moved `pending` → `no_response`. */
  recorded: string[];
  /** The subset the sweep also transitioned to `no_show`, with a fee. */
  noShowed: string[];
}

export async function runNonResponseSweep(
  clock: Clock = systemClock,
  opts: { autoNoShow?: boolean } = {},
): Promise<SweepResult> {
  const now = clock.now();
  const s = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const settings: ConfirmationSettings = {
    graceMinutes: s?.graceMinutes ?? 20,
    dayOfLeadHours: s?.dayOfLeadHours ?? 3,
  };
  // Gates the status transition and the money, and nothing else (D-10). With it
  // off this is the whole feature minus the charge: the silence is still on the
  // record, and the appointment still lands on the front-desk work list.
  const autoNoShow = opts.autoNoShow ?? s?.autoNoShowOnNoResponse ?? true;

  const candidates = await prisma.appointment.findMany({
    where: {
      // `pending` is the only state this sweep may act on, and reaching it
      // required the cadence to have queued a message. `not_required` is
      // therefore untouched by construction rather than by a branch — a client
      // on `reminderPreference: 'none'` is not in this result set at all.
      confirmation: 'pending',
      startAt: { lte: new Date(now.getTime() - settings.graceMinutes * 60_000) },
    },
    select: {
      id: true,
      clientId: true,
      status: true,
      startAt: true,
      createdAt: true,
      client: { select: { reminderPreference: true, email: true, phone: true } },
      // The receipts. A reminder row proves the practice queued a message; the
      // state on the message beside it is the only thing that proves one
      // arrived, and that is what the fee now rests on.
      reminders: { select: { outboxMessage: { select: { deliveryState: true } } } },
    },
    orderBy: { startAt: 'asc' },
  });

  const result: SweepResult = { recorded: [], noShowed: [] };

  for (const appt of candidates) {
    /**
     * Asked again, at the moment of charging.
     *
     * The horizon only looks forward, so a client who switched to `none` after
     * their last reminder went out is never returned to `not_required` by it —
     * this is the last place that safety setting can still bite, and the fee is
     * the thing it is protecting them from. Recording the silence is not gated
     * on it: the evidence is never optional, only the money is.
     */
    const eligible = confirmationRequired(appt.client, appt, settings);

    /**
     * Did anything actually reach them?
     *
     * Before receipts existed the precondition for this charge was an
     * `OutboxMessage` row, which proves the practice *intended* to ask. That is
     * not the same claim, and the gap between them is the practice's own
     * infrastructure: a carrier that dropped every message produces a client
     * who is billed for silence they were never given the chance to break, and
     * who has nothing to point at when they say the message never came.
     *
     * So `delivered`, on at least one stage. Not all three — one arrival is a
     * question asked, and a client whose `d5` landed and whose `d0` bounced was
     * still asked. And not `sent`, which is only the practice's own record of
     * handing it over.
     */
    const reached = appt.reminders.some((r) => r.outboxMessage?.deliveryState === 'delivered');
    const mayCharge = eligible && reached;

    // A front-desk check-in always beats the sweep, and a client mid-session is
    // untouchable. Only a row nobody has said anything about is guessable —
    // which also means a cancelled or completed session falls straight through
    // to the communication fact and no further.
    if (autoNoShow && mayCharge && appt.status === 'scheduled') {
      // One transaction: the status, the fee and the audit row commit together
      // or not at all. The fee is derived inside `setStatus` from
      // `noShowFeeCents`, so a sweep-set no-show and a human-set one are the
      // same money — the policy is about the fact, not about who noticed it.
      await setStatus(SYSTEM_ACTOR, appt.id, 'no_show', {
        clock,
        confirmation: 'no_response',
        auditReason: 'no_response',
      });
      result.noShowed.push(appt.id);
    } else {
      await guarded(
        {
          actor: SYSTEM_ACTOR,
          action: 'update',
          resource: 'appointment',
          resourceId: appt.id,
          clientId: appt.clientId,
          // Two different silences, and the trail says which. `undelivered`
          // means the practice never reached them — the row a client disputing
          // a policy would need, and the row an auditor would look for when the
          // charge everybody expected is missing.
          reason: eligible && !reached ? 'no_response_undelivered' : 'no_response',
        },
        (tx) =>
          tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'no_response' } }),
      );
    }
    result.recorded.push(appt.id);
  }

  return result;
}
