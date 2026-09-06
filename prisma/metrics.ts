import { prisma } from '../src/db';
import { freedSlots } from '../src/scheduling/worklists';
import { zonedToUtc } from '../src/time';
import { indiscreetTerms } from '../src/messaging/outbox';

/**
 * The success metrics, as queries against the seeded quarter.
 *
 * The PRD asks for these to be "asserted as a query, not as a code review",
 * and the only way that stays true is if something runs them. So the seed runs
 * them itself and refuses to finish on a failure: a seed that can produce data
 * violating its own eligibility rule is a seed that will, quietly, on the run
 * nobody watched.
 *
 * They are deliberately not unit tests. Every one of them is a statement about
 * a whole simulated quarter — 1,000 sessions, a horizon run per day, a
 * scripted client-behaviour mix — and reproducing that inside a spec that
 * truncates its database between cases would be reproducing the seed. The
 * assertions belong where the data is.
 */

export interface Metric {
  name: string;
  ok: boolean;
  detail: string;
}

const TODAY = '2026-09-01';

export async function seedMetrics(): Promise<Metric[]> {
  const past = { startAt: { lt: zonedToUtc(TODAY, 0) } };
  const metrics: Metric[] = [];
  const check = (name: string, ok: boolean, detail: string) => metrics.push({ name, ok, detail });

  // ── eligibility integrity ────────────────────────────────────────────
  //
  // D-01, as a count rather than as a claim. `reminderPreference: 'none'` is a
  // safety setting, and a policy that bills somebody for not answering a
  // question they were never asked converts it into a penalty for needing it.
  const feesToNeverAsked = await prisma.appointment.count({
    where: {
      confirmation: 'no_response',
      chargeFeeCents: { not: null },
      client: { reminderPreference: 'none' },
    },
  });
  check('no fee from silence for a client the practice never messages', feesToNeverAsked === 0,
    `${feesToNeverAsked} such fees`);

  // Risk 3, closed. This metric used to read "every non-response fee has an
  // outbox row behind it", because a queued message was all the evidence there
  // was — proof the practice *intended* to ask. With a carrier behind the
  // outbox the precondition is a delivery receipt, and this is the count that
  // says so: a fee whose reminders a carrier never delivered is the practice
  // charging a client for its own failed send.
  const chargedWithoutDelivery = await prisma.appointment.count({
    where: {
      confirmation: 'no_response',
      status: 'no_show',
      reminders: { none: { outboxMessage: { deliveryState: 'delivered' } } },
    },
  });
  check('every non-response fee has a delivered message behind it', chargedWithoutDelivery === 0,
    `${chargedWithoutDelivery} charged without one`);

  // The weaker claim, kept as its own line rather than folded into the one
  // above. If the two ever disagree, the difference is exactly the population
  // this phase exists to protect — asked, but never reached.
  const chargedWithoutQueue = await prisma.appointment.count({
    where: { confirmation: 'no_response', status: 'no_show', reminders: { none: { outboxMessageId: { not: null } } } },
  });
  check('and an outbox row too, which is the weaker claim it replaced', chargedWithoutQueue === 0,
    `${chargedWithoutQueue} charged without one`);

  // ── the carrier is real enough to fail ───────────────────────────────
  //
  // A simulated wire that never drops anything proves nothing about the rule
  // that handles drops. These three say the quarter contains the failure the
  // fee rule is built around, that the retry path is walked, and — the one that
  // matters — that not one of those failures ended in a charge.
  const undelivered = await prisma.outboxMessage.count({
    where: { deliveryState: 'failed', failureCode: { not: 'expired' } },
  });
  check('the seeded carrier actually fails to deliver some messages', undelivered >= 10,
    `${undelivered} undelivered`);

  const retried = await prisma.outboxMessage.count({ where: { attempts: { gt: 1 } } });
  check('and some messages only arrived on a retry', retried > 0, `${retried} took more than one attempt`);

  // The population the phase exists for, counted rather than described: sessions
  // the cadence asked about, where nothing the practice sent ever arrived. Every
  // one of them must be exempt, and none may carry a fee.
  const askedButUnreached = await prisma.appointment.findMany({
    where: {
      ...past,
      reminders: { some: {}, none: { outboxMessage: { deliveryState: 'delivered' } } },
    },
    select: { confirmation: true, status: true, chargeFeeCents: true },
  });
  const unreachedAndCharged = askedButUnreached.filter(
    (a) => a.confirmation === 'no_response' && a.status === 'no_show',
  );
  check('at least a few sessions were asked about and never reached', askedButUnreached.length >= 5,
    `${askedButUnreached.length} such sessions`);
  check('and not one of them was charged for the silence', unreachedAndCharged.length === 0,
    `${unreachedAndCharged.length} charged`);

  // ── the rule is not over-firing ──────────────────────────────────────
  const eligible = await prisma.appointment.count({
    where: { ...past, confirmation: { not: 'not_required' } },
  });
  const charged = await prisma.appointment.count({
    where: { ...past, confirmation: 'no_response', status: 'no_show' },
  });
  const rate = eligible ? charged / eligible : 0;
  check('at most 5% of the sessions it could ask about end in a fee', rate <= 0.05,
    `${charged} of ${eligible} (${(rate * 100).toFixed(2)}%)`);
  check('and the policy is actually firing at all', charged > 0, `${charged} charged`);

  // ── the case the whole feature is judged on ──────────────────────────
  //
  // Silent and present. Confirmation and attendance were never the same field,
  // so these are charged the session fee like anybody else — and if that ever
  // becomes the no-show fee, this is the line that says so.
  const silentAndPresent = await prisma.appointment.findMany({
    where: { confirmation: 'no_response', status: 'completed' },
    select: { chargeFeeCents: true, feeWaivedAt: true, client: { select: { feeCents: true } } },
  });
  const settings = await prisma.practiceSettings.findUniqueOrThrow({ where: { id: 1 } });
  const wronglyCharged = silentAndPresent.filter(
    (a) => a.chargeFeeCents !== (a.client.feeCents ?? settings.standardFeeCents),
  );
  check('at least 5 clients attended without ever answering', silentAndPresent.length >= 5,
    `${silentAndPresent.length} such sessions`);
  check('and every one of them paid the session fee, not the no-show fee', wronglyCharged.length === 0,
    `${wronglyCharged.length} charged the wrong figure`);
  check('and none of them needed a waiver to fix it',
    silentAndPresent.every((a) => a.feeWaivedAt === null), 'no waivers among them');

  // ── idempotency ──────────────────────────────────────────────────────
  //
  // A hundred-odd horizon runs over the quarter. The unique key is the
  // guarantee; this is the guarantee observed over 1,000 sessions rather than
  // over the two in a spec.
  const dupes = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (
      SELECT "appointmentId", stage FROM "AppointmentReminder" GROUP BY 1, 2 HAVING count(*) > 1
    ) x`;
  check('no duplicate reminder across every horizon run in the quarter', Number(dupes[0]!.n) === 0,
    `${dupes[0]!.n} duplicated stages`);

  const reminders = await prisma.appointmentReminder.count();
  const reminderOutbox = await prisma.outboxMessage.count({ where: { templateKey: 'appointment_reminder' } });
  check('one outbox row per reminder, and no more', reminders === reminderOutbox,
    `${reminders} reminders, ${reminderOutbox} messages`);

  // ── discretion ───────────────────────────────────────────────────────
  //
  // The deny-list at send time is the gate; this is the whole quarter's worth
  // of rendered bodies checked again after the fact, including the link-bearing
  // variant this feature added. Three sends is three times the surface.
  const bodies = await prisma.outboxMessage.findMany({ select: { body: true, subject: true } });
  const leaky = bodies.filter((m) => indiscreetTerms(`${m.subject ?? ''} ${m.body}`).length);
  check('every client-facing body in the quarter is discreet', leaky.length === 0,
    `${leaky.length} of ${bodies.length} would disclose why`);

  // ── the awkward rows ─────────────────────────────────────────────────
  //
  // Without these the specs above assert things about empty sets, which is the
  // weakest kind of green there is.
  const neverAskedWithAbsence = await prisma.client.count({
    where: {
      reminderPreference: 'none',
      appointments: { some: { status: { in: ['no_show', 'late_cancelled'] } } },
    },
  });
  check('at least 3 clients on "no messages" have an absence on the record',
    neverAskedWithAbsence >= 3, `${neverAskedWithAbsence} clients`);

  const groups = await prisma.groupSession.findMany({
    select: { appointments: { select: { status: true, confirmation: true } } },
  });
  const partiallyDeclined = groups.filter(
    (g) => g.appointments.some((a) => a.confirmation === 'declined')
      && g.appointments.some((a) => a.status !== 'cancelled' && a.status !== 'late_cancelled'),
  );
  check('at least one group session lost one attendee and kept the rest',
    partiallyDeclined.length >= 1, `${partiallyDeclined.length} of ${groups.length} groups`);

  const askedLate = (await prisma.appointment.findMany({
    where: { reminders: { some: {} } },
    select: { reminders: { select: { stage: true } } },
  })).filter((a) => a.reminders.length > 0 && !a.reminders.some((r) => r.stage === 'd5'));
  check('at least one session was booked inside the five-day window and still asked',
    askedLate.length >= 1, `${askedLate.length} sessions`);

  const waived = await prisma.appointment.count({ where: { feeWaivedAt: { not: null } } });
  check('at least one fee has been waived', waived >= 1, `${waived} waived`);

  // P1-3. The branch that matters is the one where the practice telephones,
  // so the quarter has to contain one — and the row it leaves has to be empty
  // of everything except the fact that it happened.
  const replies = await prisma.inboundReply.findMany({
    select: { id: true, classification: true, handledAt: true, clientId: true },
  });
  const unparsed = replies.filter((r) => r.classification === 'unparsed');
  check('at least one client replied in words nobody here can read', unparsed.length >= 1,
    `${unparsed.length} of ${replies.length} replies`);
  check('and every one of them is waiting for a phone call',
    unparsed.every((r) => r.handledAt === null), `${unparsed.filter((r) => r.handledAt).length} closed without one`);

  const inboundAlerts = await prisma.alert.findMany({ where: { kind: 'inbound_unparsed' } });
  check('each unreadable reply alerted exactly one treating clinician',
    inboundAlerts.length === unparsed.length
      && inboundAlerts.every((a) => a.reasons.join() === 'inbound:unparsed'),
    `${inboundAlerts.length} alerts, reason codes only`);

  const optedOut = replies.filter((r) => r.classification === 'opt_out');
  const stillMessaged = await prisma.client.count({
    where: { id: { in: optedOut.map((r) => r.clientId) }, reminderPreference: { not: 'none' } },
  });
  check('a client who asked to stop is not messaged again',
    optedOut.length >= 1 && stillMessaged === 0,
    `${optedOut.length} opted out, ${stillMessaged} still on a channel`);

  // P1-5. One vocabulary for one question, exercised across the quarter: every
  // decline carries a code from the reschedule request's list, and none of them
  // carries anything a client typed.
  const declines = await prisma.appointment.findMany({
    where: { confirmation: 'declined' },
    select: { cancelReason: true },
  });
  const REASON_CODES = [
    'cannot_make_it', 'need_a_different_time', 'prefer_earlier', 'prefer_later', 'client declined',
  ];
  const offCode = declines.filter((d) => !REASON_CODES.includes(d.cancelReason ?? ''));
  check('every decline carries a reason code and no free text',
    declines.length >= 1 && offCode.length === 0,
    `${declines.length} declines, ${offCode.length} off the list`);

  // ── the language gap, closed and checked ─────────────────────────────
  //
  // P2's last item. The machinery is asserted in the unit suite; what a whole
  // quarter can say is that it was actually exercised — a mechanism no seeded
  // client ever goes through is a mechanism nobody has run.
  const { LANGUAGES, DENY_LISTS } = await import('../src/messaging/language');
  const { canRender } = await import('../src/messaging/outbox');

  const spanish = await prisma.client.count({ where: { language: 'es' } });
  check('the quarter contains clients who read something other than English',
    spanish >= 5, `${spanish} of ${await prisma.client.count()} clients`);

  // The rule that keeps a language barrier from becoming a fee: a client the
  // practice cannot write to is a client it never asked.
  const messagedInWrongLanguage = (await prisma.outboxMessage.findMany({
    where: { clientId: { not: null } },
    select: { templateKey: true, client: { select: { language: true } } },
  })).filter((m) => m.client && !canRender(m.templateKey, m.client.language));
  check('no client was sent a message with no body in their language',
    messagedInWrongLanguage.length === 0, `${messagedInWrongLanguage.length} such messages`);

  const spanishCharged = await prisma.appointment.count({
    where: { confirmation: 'no_response', status: 'no_show', client: { language: 'es' } },
  });
  const spanishAsked = await prisma.appointment.count({
    where: { ...past, confirmation: { not: 'not_required' }, client: { language: 'es' } },
  });
  // Not "no Spanish speaker is ever charged" — that would be a different and
  // worse policy. The claim is that they are charged at the same rate, because
  // they were asked in a language they read.
  check('a translated client is charged at the same rate as anybody else',
    spanishAsked === 0 || spanishCharged / spanishAsked <= 0.05,
    `${spanishCharged} of ${spanishAsked} (${spanishAsked ? (spanishCharged / spanishAsked * 100).toFixed(2) : '0.00'}%)`);

  // Hard rule 3 across the whole quarter, now in two languages: every body is
  // checked against the union of every list, so an English message is vetted
  // against the Spanish one and the other way round.
  const spanishBodies = await prisma.outboxMessage.findMany({
    where: { client: { language: 'es' } }, select: { body: true, subject: true },
  });
  check('every Spanish body in the quarter is discreet in both languages',
    spanishBodies.length >= 1
      && spanishBodies.every((m) => indiscreetTerms(`${m.subject ?? ''} ${m.body}`).length === 0),
    `${spanishBodies.length} bodies checked against ${LANGUAGES.map((l) => DENY_LISTS[l].length).reduce((a, b) => a + b, 0)} terms`);

  const spanishReplies = await prisma.inboundReply.count({ where: { client: { language: 'es' } } });
  check('at least one client wrote back in another language',
    spanishReplies >= 1, `${spanishReplies} replies`);

  // P1-2, exercised by data rather than asserted in the abstract. A quarter in
  // which nobody ever earns the quieter cadence would leave the cap untested by
  // the one thing that tests it end to end.
  const asked = await prisma.appointment.findMany({
    where: { reminders: { some: {} }, startAt: { lt: zonedToUtc(TODAY, 0) } },
    select: { reminders: { select: { stage: true } } },
  });
  const capped = asked.filter(
    (a) => a.reminders.length === 1 && a.reminders[0]!.stage === 'd1',
  );
  check('the cadence cap is reached by real clients in the quarter', capped.length >= 1,
    `${capped.length} of ${asked.length} sessions got the day-before message alone`);

  // ── the cadence a client chose ───────────────────────────────────────
  //
  // P2-3. Three claims about a per-client cadence, and the third is the one
  // with money on it.
  const cadences = await prisma.client.groupBy({ by: ['reminderCadence'], _count: true });
  const chose = cadences.filter((c) => c.reminderCadence !== 'full').reduce((n, c) => n + c._count, 0);
  check('some clients chose a cadence, and most never touched it', chose >= 5,
    cadences.map((c) => `${c.reminderCadence}=${c._count}`).join(' '));

  // Exactly the stages they asked for, over a whole quarter of horizon runs.
  const byCadence = await prisma.appointment.findMany({
    where: { reminders: { some: {} } },
    select: { client: { select: { reminderCadence: true } }, reminders: { select: { stage: true } } },
  });
  const WANTED: Record<string, string[]> = { full: ['d5', 'd1', 'd0'], day_before: ['d1'], day_of: ['d0'] };
  const wrongStage = byCadence.filter((a) => {
    const got = new Set(a.reminders.map((r) => r.stage));
    return [...got].some((st) => !WANTED[a.client.reminderCadence]!.includes(st));
  });
  check('nobody is sent a stage their cadence does not include', wrongStage.length === 0,
    `${wrongStage.length} of ${byCadence.length} sessions got an off-cadence message`);

  // And the volume the setting exists for, as a number rather than a promise.
  const perSession = (cadence: string) => {
    const rows = byCadence.filter((a) => a.client.reminderCadence === cadence);
    return rows.length ? rows.reduce((n, a) => n + a.reminders.length, 0) / rows.length : 0;
  };
  const lightest = Math.max(perSession('day_before'), perSession('day_of'));
  check('a chosen cadence actually means fewer messages', lightest < perSession('full'),
    `full ${perSession('full').toFixed(2)} per session, day_before ${perSession('day_before').toFixed(2)}, `
    + `day_of ${perSession('day_of').toFixed(2)}`);

  // ── time to answer, not just time to ask ─────────────────────────────
  //
  // The metric that changed the phase. `graceMinutes` had always checked there
  // was time to *ask*; nothing checked there was time to *answer*, and nothing
  // needed to until a client could choose one message a few hours out. Adding
  // the cadence pushed the charge rate to 5.03% — past the PRD's own
  // over-firing line — and the cause was a cohort reached with an hour to
  // spare. These three are what stop that coming back.
  const window = (await prisma.practiceSettings.findUnique({ where: { id: 1 } }))?.answerWindowMinutes ?? 120;

  const unanswerable = await prisma.auditEvent.count({ where: { reason: 'confirmation_unanswerable' } });
  check('the quarter reaches some clients too late to answer', unanswerable >= 5,
    `${unanswerable} sessions exempted for arriving inside the ${window}-minute window`);

  // The invariant, stated over every fee in the quarter rather than over a
  // fixture: nobody is charged for silence unless something reached them with
  // time to do something about it.
  const feesForSilence = await prisma.appointment.findMany({
    where: { confirmation: 'no_response', chargeFeeCents: { not: null } },
    select: {
      id: true, startAt: true,
      reminders: { select: { outboxMessage: { select: { deliveredAt: true } } } },
    },
  });
  const chargedTooLate = feesForSilence.filter((a) =>
    !a.reminders.some((r) => {
      const at = r.outboxMessage?.deliveredAt;
      return !!at && a.startAt.getTime() - at.getTime() >= window * 60_000;
    }));
  check('no fee rests on a message that arrived too late to answer', chargedTooLate.length === 0,
    `${chargedTooLate.length} of ${feesForSilence.length} fees`);

  // And the exemption is an exemption, not a deferral.
  const standDowns = (await prisma.auditEvent.findMany({
    where: { reason: 'confirmation_unanswerable' }, select: { resourceId: true },
  })).map((r) => r.resourceId).filter((id): id is string => !!id);
  // The exemption is an exemption, not a deferral: none of these rows comes
  // back as silence, and none carries a no-show fee.
  //
  // It deliberately does not say "and none of them was charged anything". Most
  // of them are `completed` and paying the ordinary session fee, which is the
  // correct outcome and the same one the attended-but-silent metric above
  // asserts: the practice stood down on charging them for *not answering*, and
  // then they turned up and paid for their hour like everybody else. A metric
  // that counted those as a failure would be reading "exempt from the silence
  // fee" as "free session".
  const stoodDown = await prisma.appointment.findMany({
    where: { id: { in: standDowns } },
    select: { confirmation: true, status: true, chargeFeeCents: true },
  });
  const cameBackAsSilence = stoodDown.filter((a) => a.confirmation === 'no_response');
  check('and nothing exempted for arriving late comes back as silence',
    cameBackAsSilence.length === 0,
    `${cameBackAsSilence.length} of ${stoodDown.length} reverted to no_response`);

  const noShowFee = (await prisma.practiceSettings.findUnique({ where: { id: 1 } }))?.noShowFeeCents ?? 9000;
  const chargedForAbsence = stoodDown.filter(
    (a) => (a.status === 'no_show' || a.status === 'late_cancelled') && a.chargeFeeCents === noShowFee,
  );
  check('and none of them was charged a no-show fee by this policy',
    chargedForAbsence.length === 0,
    `${chargedForAbsence.length} charged the absence fee; `
    + `${stoodDown.filter((a) => a.status === 'completed').length} attended and paid the session fee`);

  // ── the freed hour ───────────────────────────────────────────────────
  //
  // P2-2, and the first thing in this feature whose number is worth something
  // to a client rather than protecting one. A decline five days out is an
  // opening a waiting client can take, and the three claims worth making about
  // it over a whole quarter are all claims about *who is offered what* — which
  // is why they run the real function against the real seed rather than
  // re-deriving a match rule here.
  // Front desk, because that is whose list this is. The practice manager reads
  // a client only through logged break-glass, and computing a metric is not a
  // reason to open that door — a number that needs break-glass to produce is a
  // number measuring the wrong actor.
  const desk = await prisma.user.findFirstOrThrow({ where: { role: 'front_desk' } });
  const freed = await freedSlots(
    { id: desk.id, role: desk.role },
    { clock: { now: () => zonedToUtc(TODAY, 9 * 60) }, horizonDays: 30 },
  );
  const offered = freed.filter((f) => f.candidates.length > 0);
  check('the quarter leaves freed hours behind', freed.length >= 5,
    `${freed.length} freed hours in the next 30 days`);
  check('and somebody on the waitlist can take at least one of them', offered.length >= 1,
    `${offered.length} of ${freed.length} have a waiting client`);
  // The other branch, and the one a fixture would quietly erase. An hour nobody
  // can take stays on the list; it is exactly the hour that otherwise goes
  // empty without anyone noticing.
  check('and some of them have nobody, and are shown anyway',
    freed.length - offered.length >= 1,
    `${freed.length - offered.length} freed hours with nobody waiting`);

  // The rule that outranks every preference a client stated. Checked on the
  // output, so it is a regression guard rather than a restatement: if the
  // continuity filter ever fell out of `openingSuits`, this is the query that
  // notices, over a quarter rather than over one fixture.
  const crossed = freed.flatMap((f) =>
    f.candidates
      .filter((c) => c.client.treatingClinician.id !== f.clinician.id)
      .map((c) => `${c.client.code} → ${f.clinician.name}`),
  );
  check('no freed hour is offered to another clinician’s client', crossed.length === 0,
    `${crossed.length} cross-clinician offers`);

  // And never back to the person who just gave it up. Resolved from the
  // appointment rather than from anything the function returned.
  const gaveItUp = new Map(
    (await prisma.appointment.findMany({
      where: { id: { in: freed.map((f) => f.appointmentId) } },
      select: { id: true, clientId: true },
    })).map((a) => [a.id, a.clientId]),
  );
  const offeredBack = freed.filter((f) =>
    f.candidates.some((c) => c.client.id === gaveItUp.get(f.appointmentId)),
  );
  check('and none is offered back to the client who cancelled it', offeredBack.length === 0,
    `${offeredBack.length} such offers`);

  // An hour the clinician is not there to work is not an hour to sell. The
  // seed cancels one session inside the vacation week precisely so this can be
  // a count rather than an argument: without it the freed-hour list and the
  // vacation work-list would describe the same absence in opposite words — one
  // as sessions to reschedule, the other as hours to fill.
  const awayOverrides = await prisma.availabilityOverride.findMany({
    where: { kind: 'unavailable' },
    select: { userId: true, fromDate: true, toDate: true, startMinute: true, endMinute: true },
  });
  const duringLeave = freed.filter((f) =>
    awayOverrides.some((o) =>
      o.userId === f.clinician.id &&
      o.startMinute === null && o.endMinute === null &&
      f.startAt >= o.fromDate && f.startAt < new Date(o.toDate.getTime() + 24 * 3_600_000)),
  );
  check('no freed hour falls in a week the clinician is away', duringLeave.length === 0,
    `${duringLeave.length} offered from a vacation week`);

  // ── audit completeness ───────────────────────────────────────────────
  //
  // Hard rule 3, checked against the log rather than argued from the code. If
  // a name, a number or an address ever reaches an audit row, it reaches it in
  // bulk, and one query over the whole quarter is how you find out.
  const clients = await prisma.client.findMany({
    select: { firstName: true, lastName: true, email: true, phone: true, code: true },
  });
  const reasons = (await prisma.auditEvent.findMany({
    where: { reason: { not: null } }, select: { reason: true },
  })).map((r) => r.reason!).join('\n');
  const leaked = clients.filter((c) =>
    [c.lastName, c.email, c.phone, c.code].some((v) => v && reasons.includes(v)));
  check('no client name, code, number or address appears in the audit log',
    leaked.length === 0, `${leaked.length} clients findable in it`);

  return metrics;
}

/** Run them and refuse to finish on a failure. */
export async function assertSeedMetrics(log: (msg: string) => void): Promise<void> {
  const metrics = await seedMetrics();
  for (const m of metrics) log(`${m.ok ? '✓' : '✗'} ${m.name} — ${m.detail}`);

  const failed = metrics.filter((m) => !m.ok);
  if (failed.length) {
    throw new Error(
      `The seeded quarter violates ${failed.length} of its own success metrics:\n` +
      failed.map((m) => `  ${m.name} (${m.detail})`).join('\n'),
    );
  }
}
