import { guarded } from '../auth/guard';
import { SYSTEM_ACTOR } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { confirmationRequired, type Confirmation, type ConfirmationSettings } from './confirmation';
import { setStatus, type Status } from './lifecycle';

/**
 * What silence means, and the two things it is not.
 *
 * A separate module from `reminders.ts` on purpose (Q6): the two jobs are due
 * at different moments, fail in different ways, and only this one touches
 * money. They share a clock and a system actor and nothing else — no shared
 * entry point, no shared loop, no "one more mode" flag on the cadence.
 *
 * The argument this file has to survive is that a practice charged somebody for
 * not answering a text. It survives it in three moves, all of them here:
 *
 *   1. Only rows the practice actually asked — `pending`, which only the cadence
 *      writes, and only when it queued a message. Eligibility is re-checked
 *      here, at the moment of the fee, rather than trusted from the moment of
 *      the send.
 *   2. Silence is recorded whatever else happened, and acted on only from
 *      `scheduled`. A client who walked in without answering ends the day
 *      `completed` / `no_response` and pays the session fee like anybody else.
 *   3. The actor is `system`. An audit row naming a person for an automatic
 *      charge would be a false statement about who decided.
 */

/**
 * What the sweep may do to one row.
 *
 * `record` and `no_show` are not two severities of the same thing: the first is
 * a communication fact and the second is an attendance fact with money on it.
 * Keeping them as separate outcomes of one pure function is what makes the
 * truth table assertable in a millisecond, without a database or a fixture.
 */
export type SweepAction = 'nothing' | 'record' | 'no_show';

/** Statuses that mean the hour is gone; the question went with it. */
const WITHDRAWN: readonly Status[] = ['cancelled', 'late_cancelled'];

/**
 * The whole policy, as a pure function of two fields and one flag.
 *
 * `no_show` is reachable from `scheduled` alone. Never from `confirmed`,
 * `arrived`, `in_session` or `completed` — a front-desk check-in always beats
 * the sweep, and a client in the room is untouchable (D-02). Never from a row
 * the practice never asked, and never from an hour that was already cancelled.
 */
export function sweepAt(
  appointment: { status: Status; confirmation: Confirmation },
  settings: { autoNoShowOnNoResponse: boolean },
): SweepAction {
  // `not_required`, `confirmed`, `declined` and an already-swept `no_response`
  // all land here: the sweep only ever decides an open question.
  if (appointment.confirmation !== 'pending') return 'nothing';
  if (WITHDRAWN.includes(appointment.status)) return 'nothing';
  if (appointment.status !== 'scheduled') return 'record';
  // D-10: the flag governs the status transition and its fee, and nothing
  // else. Recording that nobody answered is the evidence, and the evidence is
  // never optional — with the policy off this is the whole feature minus the
  // money, which is what a practice will want the week its client agreement
  // gets reviewed.
  return settings.autoNoShowOnNoResponse ? 'no_show' : 'record';
}

export interface SweepResult {
  /** Rows recorded as never having answered. */
  noResponse: string[];
  /** Of those, the ones the practice acted on. A subset, never a separate set. */
  noShow: string[];
  /** Rows the practice may no longer charge, returned to `not_required`. */
  exempted: string[];
}

/**
 * Evaluate every appointment whose grace period has run out.
 *
 * Idempotent for the same reason the cadence is: the first pass moves the row
 * off `pending`, and `pending` is the only thing this reads. Running it twice,
 * or hourly, or after a missed day, costs nothing but lateness.
 */
export async function runNonResponseSweep(clock: Clock = systemClock): Promise<SweepResult> {
  const now = clock.now();
  const s = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const settings: ConfirmationSettings = {
    graceMinutes: s?.graceMinutes ?? 20,
    dayOfLeadHours: s?.dayOfLeadHours ?? 3,
  };
  const autoNoShowOnNoResponse = s?.autoNoShowOnNoResponse ?? true;

  const candidates = await prisma.appointment.findMany({
    where: {
      // The sweep's moment: `graceMinutes` past the start. Twenty minutes is
      // the difference between a client stuck in traffic and a client who is
      // not coming, and it is also what makes the terminal `no_show` rare
      // enough to live with (Risk 5).
      startAt: { lte: new Date(now.getTime() - settings.graceMinutes * 60_000) },
      confirmation: 'pending',
      status: { notIn: [...WITHDRAWN] },
    },
    select: {
      id: true, clientId: true, status: true, confirmation: true, startAt: true, createdAt: true,
      client: { select: { reminderPreference: true, email: true, phone: true } },
      // The proof the practice asked. A `pending` row without one is
      // unreachable — only the cadence promotes, and only when it queued — so
      // this is the assertion, not the lookup.
      reminders: { where: { outboxMessageId: { not: null } }, select: { id: true }, take: 1 },
    },
    orderBy: { startAt: 'asc' },
  });

  const result: SweepResult = { noResponse: [], noShow: [], exempted: [] };

  for (const appt of candidates) {
    // P0-2, re-checked here rather than trusted from the send. A client who
    // moved to `none` — or lost the address their channel needs — after the
    // cadence started is not a client the practice may charge for silence, and
    // whichever job reaches the row first has to say so. And a row with no
    // outbox message behind it has nothing proving the practice ever asked,
    // which is the same answer for a stronger reason.
    if (!confirmationRequired(appt.client, appt, settings) || appt.reminders.length === 0) {
      await guarded(request(appt), (tx) =>
        tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'not_required' } }));
      result.exempted.push(appt.id);
      continue;
    }

    const action = sweepAt(appt, { autoNoShowOnNoResponse });
    if (action === 'nothing') continue;

    if (action === 'no_show') {
      // Through the state machine, which is the only place a `no_show` is
      // written and therefore the only place its fee is derived. The answer
      // rides along in `opts.confirmation`, so the status, the money and the
      // determination are one write with one audit row — the same seam the
      // client's own decline uses.
      await setStatus(SYSTEM_ACTOR, appt.id, 'no_show', {
        clock,
        confirmation: 'no_response',
        reason: 'no response to appointment confirmation',
      });
      result.noShow.push(appt.id);
    } else {
      await guarded(request(appt), (tx) =>
        tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'no_response' } }));
    }
    result.noResponse.push(appt.id);
  }

  return result;
}

const request = (appt: { id: string; clientId: string }) => ({
  actor: SYSTEM_ACTOR,
  action: 'update' as const,
  resource: 'appointment' as const,
  resourceId: appt.id,
  clientId: appt.clientId,
  target: { ownerClientId: appt.clientId },
});
