import { guarded } from '../auth/guard';
import { SYSTEM_ACTOR } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { answerable, deliveryProven } from '../messaging/carrier';
import { readable, type Language } from '../messaging/language';
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
 *   1b. And only rows a carrier said **arrived**. Queuing a message proves the
 *      practice intended to ask; it does not prove anybody was asked. A dead
 *      number, a bouncing mailbox and a provider outage all produce exactly the
 *      same evidence as a client ignoring you — silence — so without a delivery
 *      receipt the practice would be billing clients for its own failed sends,
 *      and would never find out, because the failure looks like the offence.
 *   1c. And only rows written in a language the client reads. Nothing is ever
 *      sent in one they do not — but `Client.language` is a field somebody can
 *      correct, and a correction does not travel back into the messages already
 *      delivered. `OutboxMessage.language` is what was actually written, so the
 *      question can be asked of the evidence rather than of the record.
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

/**
 * Whether a charge that has already landed still rests on anything.
 *
 * Every precondition in this file is asked *before* the money, once, and never
 * again — `runNonResponseSweep` reads only `pending`, so a row it has decided is
 * a row it will never look at twice. That is correct for a job and wrong for a
 * record: `Client.language` is a field somebody corrects, and a correction that
 * arrives after the sweep leaves the old fee standing on evidence that has since
 * stopped being evidence.
 *
 * The realistic version is worse than the abstract one. Corrections often happen
 * *because* somebody was charged — the client rings up, and in the conversation
 * it emerges that the practice has had them down in the wrong language all
 * along. The sweep is what produced the call, and the sweep is the one thing
 * that will never revisit its own answer.
 *
 * So the question gets asked again, from the outside, of fees that already
 * exist. Three answers rather than two, and the third is the honest one:
 *
 *   - `supported` — a delivered message in a language the client reads. The
 *     charge rests on what it always rested on.
 *   - `unreadable` — no such message, and at least one whose language *was*
 *     recorded. The strongest thing that can be said is what the list says: no
 *     message behind this charge is known to be in a language they read.
 *   - `unrecorded` — no such message and no recorded language at all. These are
 *     the rows from before `OutboxMessage.language` existed, and the answer is
 *     that nobody can tell. Counting them as unsupported would turn every
 *     historical fee into an accusation nothing can back; counting them as
 *     supported would be the assumption this whole phase exists to refuse.
 *
 * Pure, so the table is assertable without a fee, a client or a database — and
 * so the difference between "we know this was wrong" and "we cannot say" is one
 * function rather than a condition somebody re-derives on a page.
 */
export type FeeSupport = 'supported' | 'unreadable' | 'unrecorded';

export function feeSupport(
  rendered: readonly (Language | null | undefined)[],
  language: Language,
): FeeSupport {
  if (readable(rendered, language)) return 'supported';
  return rendered.some((l) => !!l) ? 'unreadable' : 'unrecorded';
}

export interface SweepResult {
  /** Rows recorded as never having answered. */
  noResponse: string[];
  /** Of those, the ones the practice acted on. A subset, never a separate set. */
  noShow: string[];
  /** Rows the practice may no longer charge, returned to `not_required`. */
  exempted: string[];
  /**
   * Of those, the ones exempted because nothing reached the client. A subset of
   * `exempted`, and reported separately because it is the one exemption that is
   * the *practice's* problem: a client nobody could reach needs a phone call,
   * not a quietly skipped fee.
   */
  undelivered: string[];
  /**
   * P2-3. Of those, the ones the practice reached too late for reaching them to
   * mean anything. A subset of `exempted`, and its own number because it is a
   * *settings* problem rather than an address problem: a cadence that keeps
   * landing inside the answering window is a cadence that cannot support the
   * fee, and the practice should see that as a count rather than as a slow
   * drift in the charge rate.
   */
  unanswerable: string[];
  /**
   * Of those, the ones the practice asked in a language the client does not
   * read. A subset of `exempted`, and its own number because it is neither of
   * the other two: the message arrived, and it arrived in time, and it was not
   * a question this client could answer.
   *
   * It only becomes reachable once a record is corrected — nothing is ever
   * *sent* in a language the client is not down as reading — so a non-zero
   * count here is a count of corrections, and the practice should read it as
   * "how often was somebody entered in the wrong language" rather than as a
   * messaging fault.
   */
  unreadable: string[];
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
  const answerWindowMinutes = s?.answerWindowMinutes ?? 120;

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
      id: true, clientId: true, status: true, confirmation: true, startAt: true, bookedAt: true,
      client: { select: { reminderPreference: true, email: true, phone: true, language: true } },
      // The proof the practice asked, and — since P2 — the proof it arrived.
      // A `pending` row with no reminder at all is unreachable, because only
      // the cadence promotes and only when it queued; what is very reachable is
      // a reminder whose message a carrier never delivered.
      reminders: {
        where: { outboxMessageId: { not: null } },
        // `deliveredAt` as well as the state, because since P2-3 the question
        // is not only whether a message arrived but whether it arrived in time
        // to be answered. And `dueAt`, because since the reschedule fix the
        // question before both is whether the message was about *this* hour.
        select: { dueAt: true, outboxMessage: { select: { deliveryState: true, deliveredAt: true, language: true } } },
      },
    },
    orderBy: { startAt: 'asc' },
  });

  const result: SweepResult = { noResponse: [], noShow: [], exempted: [], undelivered: [], unanswerable: [], unreadable: [] };

  for (const appt of candidates) {
    // The precondition before the other four, and the one this feature went
    // five phases without.
    //
    // Every rule below asks something about the message — were we allowed to
    // send it, did it arrive, did it arrive in time, could they read it — and
    // not one of them asks whether it is still about this appointment. A
    // reschedule is exactly the move that separates the two: the messages named
    // the old hour, and `answerable` would measure their delivery against the
    // new one, so moving a session *later* would make the fee easier to earn.
    //
    // `bookedAt` is when this hour was set, and `dueStages` will not queue a
    // stage whose moment fell before it — so this is the same predicate read
    // back: the evidence the fee may rest on is exactly the set of stages the
    // cadence was allowed to send about the hour the client is expected at.
    // Reminders about the withdrawn hour stay on the row as the record that the
    // practice did ask, once, about something else.
    const asked = appt.reminders.filter((r) => r.dueAt >= appt.bookedAt);

    // P0-2, re-checked here rather than trusted from the send. A client who
    // moved to `none` — or lost the address their channel needs — after the
    // cadence started is not a client the practice may charge for silence, and
    // whichever job reaches the row first has to say so. And a row with no
    // outbox message behind it has nothing proving the practice ever asked,
    // which is the same answer for a stronger reason.
    if (!confirmationRequired(appt.client, appt, settings) || asked.length === 0) {
      await guarded(request(appt, 'confirmation_not_required'), (tx) =>
        tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'not_required' } }));
      result.exempted.push(appt.id);
      continue;
    }

    // The language precondition, and the one this feature went six phases
    // without because it looked like it was already there.
    //
    // Nothing is ever *sent* in a language the client is not down as reading:
    // `queueToClient` refuses to render a template with no body in it, and the
    // cadence asks the same question before it queues. Both read
    // `Client.language`, live, at the moment of the send — which is correct, and
    // which is exactly why neither of them says anything about a record
    // corrected afterwards. A client entered as English and put right in July
    // has June's English reminders still on the row: delivered, in time, and
    // counting as having been asked, in a language they cannot read.
    //
    // So the evidence is filtered down to the messages that were actually
    // written in the language the client reads, and every check below runs on
    // that set rather than on everything the practice sent. Not just this
    // exemption: a client with two delivered English reminders and one Spanish
    // one that failed has been reached in a language they read exactly zero
    // times, and must land on `confirmation_undelivered` rather than on a fee.
    //
    // Before the delivery check rather than after it, because when both are
    // true this is the more fundamental of the two — a message that could not
    // have been answered had it arrived is not an addressing problem.
    const legible = asked.filter((r) => readable([r.outboxMessage?.language], appt.client.language));

    if (!readable(asked.map((r) => r.outboxMessage?.language), appt.client.language)) {
      await guarded(request(appt, 'confirmation_unreadable'), (tx) =>
        tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'not_required' } }));
      result.exempted.push(appt.id);
      result.unreadable.push(appt.id);
      continue;
    }

    // The delivery precondition. One delivered stage is enough — a carrier
    // hiccup on the day-of nudge should not erase a `d5` message the client
    // demonstrably received — but `sent` counts for nothing, because `sent` is
    // the old, weaker claim this phase exists to stop charging on.
    //
    // It lands on `not_required` rather than on `no_response` deliberately.
    // `no_response` is a statement about the client, and the client did not do
    // anything: the practice failed to reach them. Writing the stronger word
    // would put "did not answer" on the record of somebody who was never
    // spoken to, which is the same untruth as the fee, minus the money.
    //
    // The audit reason is its own code so the two exemptions never blur: the
    // practice may not ask, versus the practice asked and it did not arrive.
    // The second is an operational failure with a work-list behind it.
    if (!deliveryProven(legible.map((r) => r.outboxMessage?.deliveryState).filter((s) => !!s))) {
      await guarded(request(appt, 'confirmation_undelivered'), (tx) =>
        tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'not_required' } }));
      result.exempted.push(appt.id);
      result.undelivered.push(appt.id);
      continue;
    }

    // P2-3. And the other half of a question this system had only ever asked
    // one half of. `confirmationRequired` above checks there was time to *ask*,
    // measured at booking. Nothing checked there was time to *answer* — and for
    // five phases nothing needed to, because a full cadence puts the first
    // message five days out.
    //
    // A per-client cadence made it a live question, and the seeded quarter made
    // it a number: a day-of client's median gap between "delivered" and "start"
    // was one hour, and charging somebody for not answering a message that
    // arrived with an hour to spare is the delivery precondition's own argument
    // one step further along. The practice reached them, but not in time for
    // reaching them to mean anything.
    //
    // Its own audit code, so the three exemptions never blur: the practice may
    // not ask, the practice asked and it did not arrive, the practice asked and
    // it arrived too late. Only the second one is a phone call.
    if (!answerable(legible.map((r) => r.outboxMessage?.deliveredAt), appt.startAt, answerWindowMinutes)) {
      await guarded(request(appt, 'confirmation_unanswerable'), (tx) =>
        tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'not_required' } }));
      result.exempted.push(appt.id);
      result.unanswerable.push(appt.id);
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
      await guarded(request(appt, 'no_response'), (tx) =>
        tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'no_response' } }));
    }
    result.noResponse.push(appt.id);
  }

  return result;
}

/**
 * P0-9. A reason code and ids, and that is the whole row. The `no_show` branch
 * does not come through here — it goes through `setStatus`, which derives the
 * same code from the confirmation riding in the write.
 */
const request = (appt: { id: string; clientId: string }, reason: string) => ({
  actor: SYSTEM_ACTOR,
  action: 'update' as const,
  resource: 'appointment' as const,
  resourceId: appt.id,
  clientId: appt.clientId,
  target: { ownerClientId: appt.clientId },
  reason,
});
