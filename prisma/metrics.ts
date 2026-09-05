import { prisma } from '../src/db';
import { zonedToUtc } from '../src/time';

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

  // Risk 3, in the only form this project can honour it today: the fee's
  // precondition is a queued message. When a carrier is attached it must
  // become a delivery receipt, and this count is where that change lands.
  const chargedWithoutEvidence = await prisma.appointment.count({
    where: { confirmation: 'no_response', status: 'no_show', reminders: { none: { outboxMessageId: { not: null } } } },
  });
  check('every non-response fee has an outbox row behind it', chargedWithoutEvidence === 0,
    `${chargedWithoutEvidence} charged without one`);

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
  const { indiscreetTerms } = await import('../src/messaging/outbox');
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
