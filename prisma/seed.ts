/**
 * A scripted practice quarter for Stillwater Counseling.
 *
 * Everything here is synthetic and obviously so: clients are "Test Client 001"
 * with example.test addresses, and the seed refuses to run against anything
 * that looks like a hosted database. Determinism matters — the success metrics
 * are hand-tallied against this data, so the same seed must produce the same
 * quarter every time. Hence a seeded PRNG rather than Math.random.
 */
import { config } from 'dotenv';
if (!process.env.DATABASE_URL) config({ path: '.env', quiet: true });

const { prisma } = await import('../src/db');
const { actor, resetDb } = await import('../src/test/harness');
const { TEMPLATES } = await import('../src/forms/fixtures');
const { publishTemplate, issueForm, submitForm } = await import('../src/forms/service');
const { materialiseSeries } = await import('../src/scheduling/booking');
const { createProgressNote, signProgressNote, coSignProgressNote, createProcessNote } =
  await import('../src/notes/service');
const { guarded } = await import('../src/auth/guard');
const { addDays, localDateOf, zonedToUtc } = await import('../src/time');
const { bookGroupSession } = await import('../src/scheduling/groups');
const { waiveFee } = await import('../src/scheduling/lifecycle');
const { stageDueAt } = await import('../src/scheduling/confirmation');
const { ensurePortalLink } = await import('../src/portal/service');
const { queueToClient } = await import('../src/messaging/outbox');
const { dispatchOutbox, recordDeliveryReceipt } = await import('../src/messaging/delivery');
const { systemClock, fixedClock } = await import('../src/clock');
const { receiveInbound, resolveInboundReply } = await import('../src/messaging/inbound');

/** mulberry32 — small, fast, and identical on every machine. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260901);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;

/** The quarter runs to "today"; the horizon runs a month past it. */
const TODAY = '2026-09-01';
const QUARTER_START = '2026-06-01';
const HORIZON_DAYS = 35;

const log = (msg: string) => console.log(`  ${msg}`);
const addDaysMs = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

async function main() {
  console.log('\nSeeding Stillwater Counseling — synthetic data only.\n');
  await resetDb();

  await prisma.practiceSettings.create({
    data: {
      id: 1, name: 'Stillwater Counseling', messagingName: 'Stillwater',
      standardFeeCents: 18_000, lateCancelWindowHours: 24, lateCancelFeeCents: 9_000,
      recurrenceHorizonDays: 90, continuityGapDays: 21,
      // The confirmation policy, stated rather than left to defaults. The
      // no-show fee ships at the late-cancel figure so the field changes
      // nothing on the day it lands (D-09), and the auto-charge is on because
      // the practice owner asked for it (D-10) — a decision the settings page
      // says out loud needs a clinical and legal review before it is real.
      noShowFeeCents: 9_000, dayOfLeadHours: 3, graceMinutes: 20,
      autoNoShowOnNoResponse: true,
    },
  });

  const rooms = [];
  for (const name of ['Willow', 'Cedar', 'Linden', 'Aspen']) {
    rooms.push(await prisma.room.create({ data: { name } }));
  }
  log(`${rooms.length} therapy rooms`);

  // ── people ────────────────────────────────────────────────────────────
  const mk = (name: string, role: string, supervisorId?: string) =>
    prisma.user.create({
      data: {
        name, role: role as never, supervisorId: supervisorId ?? null,
        email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`,
      },
    });

  const rosa = await mk('Rosa Iyer', 'supervisor');
  const dev = await mk('Dev Marchetti', 'supervisor');
  const nour = await mk('Nour Abadi', 'therapist');
  const tom = await mk('Tom Bergqvist', 'therapist');
  const kai = await mk('Kai Oyelaran', 'therapist');
  const priya = await mk('Priya Vance', 'associate', rosa.id);
  const frontDesk = await mk('Marion Whitlock', 'front_desk');
  const manager = await mk('Elena Sarkis', 'admin');
  const auditorUser = await mk('Owen Delacroix', 'auditor');

  const clinicians = [rosa, dev, nour, tom, kai, priya];
  log(`${clinicians.length} clinicians (2 supervisors, 3 therapists, 1 associate under ${rosa.name})`);

  // Everyone works Monday–Friday, 9:00 to 17:00.
  for (const c of clinicians) {
    for (const weekday of [1, 2, 3, 4, 5]) {
      await prisma.availability.create({
        data: { userId: c.id, weekday, startMinute: 540, endMinute: 1020 },
      });
    }
  }

  // ── templates ─────────────────────────────────────────────────────────
  const admin = actor(manager);
  const desk = actor(frontDesk);
  for (const t of TEMPLATES) {
    await publishTemplate(admin, { key: t.key, name: t.name, kind: t.kind, schema: t.schema, scoring: t.scoring ?? null });
  }
  log(`${TEMPLATES.length} form templates published at v1`);

  // ── clients and their standing sessions ───────────────────────────────
  //
  const SURNAMES = ['Ashford', 'Bellweather', 'Castellanos', 'Duarte', 'Ellery', 'Fontaine',
    'Gallagher', 'Halvorsen', 'Ibarra', 'Jorgensen', 'Kowalczyk', 'Lindqvist', 'Mbeki',
    'Nakamura', 'Okafor', 'Pemberton', 'Quesada', 'Rasmussen', 'Sandoval', 'Thibodeaux'];

  const REFERRAL_MIX = [
    'gp', 'gp', 'gp', 'friend', 'friend', 'friend', 'search', 'search', 'search', 'other',
  ] as const;

  let clientNo = 0;
  const clients: { id: string; code: string; clinicianId: string }[] = [];
  const seriesIds: string[] = [];

  // Clients are dealt round-robin across the clinicians rather than filling one
  // caseload at a time, so every clinician -- including the associate whose
  // co-signature queue the demo depends on -- ends up with a real caseload.
  //
  // Hour is the outermost loop, so the 70 run out of an afternoon rather than
  // out of a weekday: with weekday outermost they filled Monday to Thursday and
  // left Friday empty, which made every Friday demo an empty calendar. Clinician
  // stays innermost, which keeps each (weekday, hour) cell filled in index
  // order -- so in-person demand there is still exactly the four non-telehealth
  // clinicians, and TC-006 is still the associate's.
  outer: for (const hour of [10, 14, 16]) {
    for (const weekday of [1, 2, 3, 4, 5]) {
      for (const [i, clinician] of clinicians.entries()) {
        if (clientNo >= 70) break outer;
        // Two of the six run mostly telehealth, which keeps in-person demand at
        // or below the four rooms at any given hour.
        const telehealthClinician = i >= 4;
        clientNo++;
        const code = `TC-${String(clientNo).padStart(3, '0')}`;
        const client = await prisma.client.create({
          data: {
            code,
            firstName: 'Test',
            lastName: `Client ${String(clientNo).padStart(3, '0')} ${pick(SURNAMES)}`,
            dateOfBirth: new Date(Date.UTC(1965 + Math.floor(rand() * 40), Math.floor(rand() * 12), 1 + Math.floor(rand() * 28))),
            email: `client${clientNo}@example.test`,
            phone: `555-01${String(clientNo).padStart(2, '0')}`,
            emergencyContactName: `Emergency Contact ${clientNo}`,
            emergencyContactPhone: `555-02${String(clientNo).padStart(2, '0')}`,
            emergencyContactRelation: pick(['Partner', 'Parent', 'Sibling', 'Friend']),
            treatingClinicianId: clinician.id,
            // A third of the practice is on a sliding scale, which is normal.
            feeCents: chance(0.3) ? pick([6_000, 9_000, 12_000, 15_000]) : null,
            reminderPreference: chance(0.1) ? 'none' : chance(0.4) ? 'sms' : 'email',
            // A share of the practice is written to in Spanish, so the horizon
            // run renders Spanish bodies in bulk and every one of them passes
            // the same deny-list gate rather than one hand-picked fixture.
            //
            // Counted, not drawn. Every `chance()` here pulls from the one
            // seeded PRNG, so adding a draw to this loop reshuffles every
            // decision made after it — the whole fixture set moves, and what
            // fails is an unrelated spec three files away.
            language: clientNo % 8 === 3 ? 'es' : 'en',
            // Counted, not drawn, for the reason above: this loop's PRNG
            // sequence is load-bearing. The mix is roughly 30/30/30/10 so the
            // referral report has a shape rather than four equal bars, and the
            // ninety-seven who were here before this column existed are not a
            // hole in the practice's own history (P0-9).
            referralSource: REFERRAL_MIX[clientNo % REFERRAL_MIX.length]!,
          },
        });
        clients.push({ id: client.id, code, clinicianId: clinician.id });

        // The last few are new referrals: booked in for an intake but not yet
        // on a standing slot. A practice always has some, and a demo where
        // every client already has a series has nowhere to show booking one.
        if (clientNo > 64) continue;

        const series = await prisma.appointmentSeries.create({
          data: {
            clientId: client.id,
            clinicianId: clinician.id,
            weekday,
            startMinute: hour * 60,
            frequency: chance(0.2) ? 'biweekly' : 'weekly',
            startDate: new Date(`${QUARTER_START}T12:00:00Z`),
            type: 'standard',
            modality: telehealthClinician || chance(0.15) ? 'telehealth' : 'in_person',
          },
        });
        seriesIds.push(series.id);
      }
    }
  }
  log(`${clients.length} clients with standing weekly or biweekly sessions`);

  // ── materialise the quarter ───────────────────────────────────────────
  let created = 0;
  let skipped = 0;
  for (const id of seriesIds) {
    const run = await materialiseSeries(desk, id, { from: QUARTER_START, horizonDays: 92 + HORIZON_DAYS });
    created += run.created.length;
    skipped += run.skipped.length;
  }
  log(`${created} sessions materialised across the quarter and horizon${skipped ? ` (${skipped} slots unavailable)` : ''}`);

  // ── walk the past into a realistic history ────────────────────────────
  //
  // Statuses are set directly rather than through the state machine: this is
  // fixture construction, not a simulation of front desk clicking through a
  // quarter, and 900 three-step transitions would make the seed unusable.
  const past = await prisma.appointment.findMany({
    where: { startAt: { lt: zonedToUtc(TODAY, 0) } },
    select: { id: true, clientId: true, clinicianId: true, startAt: true },
    orderBy: { startAt: 'asc' },
  });

  const settings = await prisma.practiceSettings.findUniqueOrThrow({ where: { id: 1 } });
  const feeByClient = new Map(
    (await prisma.client.findMany({ select: { id: true, feeCents: true } })).map((c) => [c.id, c.feeCents]),
  );

  const completed: typeof past = [];
  for (const appt of past) {
    const roll = rand();
    if (roll < 0.05) {
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: 'late_cancelled', cancelledAt: new Date(appt.startAt.getTime() - 3 * 3600_000), chargeFeeCents: settings.lateCancelFeeCents, cancelReason: 'client cancelled' },
      });
    } else if (roll < 0.09) {
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: 'cancelled', cancelledAt: new Date(appt.startAt.getTime() - 5 * 86_400_000), cancelReason: 'client rescheduled' },
      });
    } else if (roll < 0.12) {
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: 'no_show', chargeFeeCents: settings.noShowFeeCents },
      });
    } else {
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: 'completed', chargeFeeCents: feeByClient.get(appt.clientId) ?? settings.standardFeeCents },
      });
      completed.push(appt);
    }
  }
  log(`${completed.length} completed, ${past.length - completed.length} cancelled, late-cancelled or missed`);

  // A slice of the near future is confirmed; the rest stays merely scheduled.
  await prisma.appointment.updateMany({
    where: { startAt: { gte: zonedToUtc(TODAY, 0), lt: zonedToUtc(addDays(TODAY, 7), 0) } },
    data: { status: 'confirmed' },
  });

  // ── the confirmation loop ─────────────────────────────────────────────
  //
  // The awkward rows, constructed explicitly. Left to the dice these are
  // likely but not certain, and every one of them is a row a spec asserts
  // against — a fixture the seed only *probably* produces is a spec that only
  // probably means anything.
  const now = systemClock.now();

  /**
   * Ask, for real: three reminder rows and three outbox rows, then whatever
   * the client did or did not do about it. `pending` is only honest where
   * something actually queued, because that is the whole invariant the fee
   * rests on — no charge without a row proving the practice asked.
   */
  async function asked(
    appt: { id: string; clientId: string; startAt: Date },
    answer: 'pending' | 'confirmed' | 'declined' | 'no_response',
    stages: readonly ('d5' | 'd1' | 'd0')[] = ['d5', 'd1', 'd0'],
    /** P1-5. Optional, and mostly absent — most declines never say why. */
    declineReason?: 'cannot_make_it' | 'need_a_different_time' | 'prefer_earlier' | 'prefer_later',
    /**
     * P2. Whether the carrier came back. `delivered` is the ordinary case and
     * the one the fee rests on; `failed` is the practice's own send failing,
     * which records the silence and charges nothing.
     */
    delivery: 'delivered' | 'failed' = 'delivered',
  ) {
    const link = await ensurePortalLink(appt.clientId, systemClock);
    for (const stage of stages) {
      const dueAt = stageDueAt(appt.startAt, stage, { graceMinutes: 20, dayOfLeadHours: 3 });
      const message = await queueToClient({
        clientId: appt.clientId,
        templateKey: 'appointment_reminder',
        scheduledFor: dueAt,
        startAt: appt.startAt,
        link: `http://localhost:3700/p/${link.token}`,
      });
      if (!message) return false; // the client is on `none`; nothing was asked
      await prisma.appointmentReminder.create({
        data: { appointmentId: appt.id, stage, dueAt, sentAt: dueAt, outboxMessageId: message.id },
      });
      // Through the real receipt path, so the seeded rows are the ones a
      // carrier would have produced rather than a shape only the seed knows.
      await recordDeliveryReceipt(
        message.id, delivery, fixedClock(dueAt), delivery === 'failed' ? 'unreachable' : undefined,
      );
    }
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { confirmation: answer, declineReason: declineReason ?? null },
    });
    return true;
  }

  // Three clients on `none` who have missed sessions. The exemption has to be
  // exercised by data rather than asserted in the abstract: these are the rows
  // that prove a safety setting did not quietly become a billing trap.
  const exempt = clients.slice(30, 33);
  let exemptAbsences = 0;
  for (const c of exempt) {
    await prisma.client.update({ where: { id: c.id }, data: { reminderPreference: 'none' } });
    const theirs = await prisma.appointment.findMany({
      where: { clientId: c.id, status: 'completed' }, orderBy: { startAt: 'desc' }, take: 2,
    });
    for (const appt of theirs) {
      await prisma.appointment.update({
        where: { id: appt.id },
        // A human noticed the absence and set it. `confirmation` stays
        // `not_required` forever, so no fee here is ever derived from silence.
        data: { status: 'no_show', chargeFeeCents: settings.noShowFeeCents, confirmation: 'not_required' },
      });
      exemptAbsences++;
    }
  }
  log(`${exempt.length} clients on reminderPreference 'none' with ${exemptAbsences} absences between them`);

  // The client the whole feature is about: asked three times, answered never,
  // and walked in anyway. Charged the session fee, not the policy fee.
  // Reachable clients only: `asked` refuses to invent an ask it could not have
  // sent, so a client on `none` here would silently produce nothing.
  const reachable = new Set(
    (await prisma.client.findMany({ where: { reminderPreference: { not: 'none' } }, select: { id: true } }))
      .map((c) => c.id),
  );
  const silentButPresent = completed.filter((a) => reachable.has(a.clientId)).slice(-6);
  for (const appt of silentButPresent) await asked(appt, 'no_response');
  log(`${silentButPresent.length} completed sessions the client never answered about — session fee only`);

  // And the other kind of silence: asked, never answered, never turned up.
  const silentAndAbsent = await prisma.appointment.findMany({
    where: {
      status: 'no_show', confirmation: 'not_required',
      client: { reminderPreference: { not: 'none' } },
    },
    orderBy: { startAt: 'desc' },
    take: 4,
  });
  //
  // One of them is the P2 row: three messages queued, three handed over, and
  // the carrier came back `failed` on every one. Same silence, same absence,
  // same evidence on the record — and no fee, because the practice never
  // reached them. It is the only row in the quarter where `no_response` and
  // `no_show` sit together with nothing charged.
  const undelivered = silentAndAbsent.at(-1);
  for (const appt of silentAndAbsent) {
    const reached = appt.id !== undelivered?.id;
    if (await asked(appt, 'no_response', ['d5', 'd1', 'd0'], undefined, reached ? 'delivered' : 'failed')) {
      // Explicitly null on the undelivered one: these rows were seeded as
      // ordinary no-shows further up and already carry a fee a human set. The
      // policy is not allowed to keep money it could not have earned.
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { chargeFeeCents: reached ? settings.noShowFeeCents : null },
      });
    }
  }
  log(`${silentAndAbsent.length} no-shows the policy would charge for, 1 of them undelivered and therefore free`);

  // One of them waived, through the real path so the audit row is real too.
  const toWaive = silentAndAbsent[0];
  if (toWaive) {
    await waiveFee(actor(manager), toWaive.id, 'client_disputed');
    log('1 fee waived by the practice manager, with the original amount in the audit log');
  }

  // A booking made inside the five-day window: it skips `d5` permanently and
  // is still fee-eligible on the two stages that were sendable.
  const soon = await prisma.appointment.findFirst({
    where: { status: 'scheduled', startAt: { gte: addDaysMs(now, 2), lt: addDaysMs(now, 4) } },
    orderBy: { startAt: 'asc' },
  });
  if (soon) {
    await prisma.appointment.update({
      where: { id: soon.id },
      data: { createdAt: addDaysMs(soon.startAt, -2), confirmation: 'pending' },
    });
    for (const stage of ['d1', 'd0'] as const) {
      const dueAt = stageDueAt(soon.startAt, stage, { graceMinutes: 20, dayOfLeadHours: 3 });
      const message = await queueToClient({
        clientId: soon.clientId, templateKey: 'appointment_reminder', scheduledFor: dueAt,
        startAt: soon.startAt, link: `http://localhost:3700/p/${(await ensurePortalLink(soon.clientId, systemClock)).token}`,
      });
      if (message) {
        await prisma.appointmentReminder.create({
          data: { appointmentId: soon.id, stage, dueAt, sentAt: dueAt, outboxMessageId: message.id },
        });
        await recordDeliveryReceipt(message.id, 'delivered', fixedClock(dueAt));
      }
    }
    log('1 booking made inside the five-day window — d5 skipped, d1 and d0 sent');
  }

  // A group session where one attendee declined. The group, the room and every
  // co-attendee are untouched: a group is N appointments sharing a key.
  const groupClients = clients.slice(40, 45);
  const group = await bookGroupSession(desk, {
    clinicianId: nour.id,
    clientIds: groupClients.map((c) => c.id),
    date: addDays(TODAY, 21),
    startMinute: 18 * 60,
    topic: 'Tuesday skills group',
  });
  for (const [i, a] of group.appointments.entries()) {
    const full = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    await asked(
      full,
      i === 0 ? 'declined' : i === 1 ? 'pending' : 'confirmed',
      ['d5', 'd1', 'd0'],
      i === 0 ? 'cannot_make_it' : undefined,
    );
  }
  await prisma.appointment.update({
    where: { id: group.appointments[0]!.id },
    data: { status: 'cancelled', cancelledAt: now, cancelReason: 'client declined' },
  });
  log(`1 group session of ${group.appointments.length} — 1 declined, 1 still silent, the rest confirmed`);


  // ── P1-5: two past declines, one that said why and one that did not ────
  //
  // The report's decline-reason line is only honest if the seed contains both
  // kinds. The unexplained one is the majority case in reality — the portal
  // asks without requiring an answer, and a texted "no" cannot carry one — so
  // it is here rather than being quietly rounded away.
  const decliners = clients.slice(45, 47);
  let seededDeclines = 0;
  for (const [i, c] of decliners.entries()) {
    const upcoming = await prisma.appointment.findFirst({
      where: { clientId: c.id, status: 'scheduled', startAt: { gt: now } },
      orderBy: { startAt: 'asc' },
    });
    if (!upcoming) continue;
    if (!(await asked(upcoming, 'declined', ['d5', 'd1', 'd0'], i === 0 ? 'prefer_later' : undefined))) continue;
    await prisma.appointment.update({
      where: { id: upcoming.id },
      data: { status: 'cancelled', cancelledAt: now, cancelReason: 'client declined' },
    });
    seededDeclines++;
  }
  log(`${seededDeclines} portal declines — 1 with a reason code, 1 that said nothing`);

  // ── P1-2: the standing client who has earned quiet ─────────────────────
  //
  // Four confirmations in a row, and then the next session asked about once,
  // the day before. Constructed rather than left to a horizon run, for the same
  // reason as everything else here: a fixture the seed only probably produces
  // is a demo that only probably shows the feature.
  const reliable = clients[50]!;
  await prisma.client.update({ where: { id: reliable.id }, data: { reminderPreference: 'email' } });
  const theirLastFour = await prisma.appointment.findMany({
    where: { clientId: reliable.id, status: 'completed' },
    orderBy: { startAt: 'desc' },
    take: 4,
  });
  for (const appt of theirLastFour) await asked(appt, 'confirmed');
  const nextForReliable = await prisma.appointment.findFirst({
    where: { clientId: reliable.id, status: 'scheduled', startAt: { gte: now } },
    orderBy: { startAt: 'asc' },
  });
  if (nextForReliable) await asked(nextForReliable, 'pending', ['d1']);
  log(`1 client with ${theirLastFour.length} confirmations in a row — their next session asked about once, not three times`);

  // ── P2: the client who asked for one nudge, on the day ─────────────────
  //
  // The same four confirmations as the client above, and a selection of their
  // own on top. The pair is the point: the streak would cap this one to the day
  // before, and their `d0` is what they actually get. Two reductions stacked
  // would have left them with nothing.
  const dayOfOnly = clients[55]!;
  await prisma.client.update({
    where: { id: dayOfOnly.id },
    data: { reminderPreference: 'sms', reminderStages: ['d0'] },
  });
  for (const appt of await prisma.appointment.findMany({
    where: { clientId: dayOfOnly.id, status: 'completed' },
    orderBy: { startAt: 'desc' },
    take: 4,
  })) {
    await asked(appt, 'confirmed');
  }
  log('1 client on a day-of-only cadence they chose — the streak cap does not narrow it further');

  // ── P2: the clients the practice writes in Spanish ─────────────────────
  //
  // Deterministic, because "some of the practice is Spanish-speaking" produced
  // by chance is a demo that only probably shows the feature. One takes the
  // ordinary cadence, so there are Spanish reminder bodies on the outbox to
  // read; the other answers one in Spanish through the real inbound path,
  // which is the half that would silently break — an unfolded `sí` normalises
  // to `s`, classifies as unparsed, and turns every Spanish yes into an alert
  // and a phone call.
  const spanish = [clients[56]!, clients[57]!];
  for (const c of spanish) {
    await prisma.client.update({ where: { id: c.id }, data: { language: 'es', reminderPreference: 'sms' } });
  }
  const nextForSpanish = await prisma.appointment.findFirst({
    where: { clientId: spanish[0]!.id, status: 'scheduled', startAt: { gte: now } },
    orderBy: { startAt: 'asc' },
  });
  if (nextForSpanish) await asked(nextForSpanish, 'pending');
  log('2 clients written to in Spanish — bodies and deny-list both');

  // ── P1-3: the clients who wrote back in words ──────────────────────────
  //
  // Through the real path, so the alert, the auto-reply and the audit row are
  // the ones the application writes. The bodies below exist only inside
  // `receiveInbound`: none of them reaches a column, which is the entire point
  // and is worth seeing proved against seeded data rather than only in a test.
  const writers = [clients[51]!, clients[52]!, clients[53]!, clients[54]!];
  for (const c of writers) {
    await prisma.client.update({ where: { id: c.id }, data: { reminderPreference: 'sms' } });
  }
  const numberOf = async (id: string) =>
    (await prisma.client.findUniqueOrThrow({ where: { id }, select: { phone: true } })).phone!;

  await receiveInbound({ from: await numberOf(writers[0]!.id), body: 'Y' });
  // A decline in words. The hour still stands and the fee is untouched: a text
  // cannot carry the disclosure the portal shows, so front desk rings them.
  await receiveInbound({ from: await numberOf(writers[1]!.id), body: "Can't make it" });
  await receiveInbound({
    from: await numberOf(writers[2]!.id),
    body: 'no sorry, things have been really hard this week and I am not up to it',
  });
  await receiveInbound({ from: await numberOf(writers[3]!.id), body: 'who is this?' });
  // The Spanish yes, through the same path. It is a `confirm` and not an
  // alert, which is the whole of what folding the accent buys.
  await receiveInbound({ from: await numberOf(spanish[1]!.id), body: 'Sí' });

  // One already dealt with, so the list has a cleared row in it as well as an
  // open one — a queue that is only ever empty or only ever full demos badly.
  const handled = await prisma.inboundReply.findFirst({
    where: { clientId: writers[3]!.id, classification: 'unparsed' },
  });
  if (handled) await resolveInboundReply(desk, handled.id);
  log('5 inbound replies: 2 confirms (1 in Spanish), 1 decline that leaves the hour standing, 2 unparsed (1 already called back)');

  // ── notes ─────────────────────────────────────────────────────────────
  const byClinician = new Map<string, typeof past>();
  for (const a of completed) byClinician.set(a.clinicianId, [...(byClinician.get(a.clinicianId) ?? []), a]);

  let progressNotes = 0, coSigned = 0, pending = 0, processNotes = 0;

  for (const clinician of clinicians) {
    const theirs = (byClinician.get(clinician.id) ?? []).slice(-14);
    for (const appt of theirs) {
      const author = actor(clinician);
      const note = await createProgressNote(author, {
        appointmentId: appt.id,
        content: [
          'Presenting: ongoing work on the goals agreed at intake.',
          'Intervention: reviewed the week, practised the between-session task.',
          'Plan: continue weekly; revisit the plan in four sessions.',
        ].join('\n\n'),
      });
      progressNotes++;

      // A couple of the most recent stay in draft, as they would in life.
      if (chance(0.85)) {
        const signed = await signProgressNote(author, note.id);
        if (signed.pendingCoSignature) {
          // Most get countersigned; a few sit in the queue, ageing.
          if (chance(0.7)) {
            await coSignProgressNote(actor(rosa), note.id);
            coSigned++;
          } else {
            pending++;
          }
        }
      }

      if (chance(0.4)) {
        await createProcessNote(author, {
          clientId: appt.clientId,
          appointmentId: appt.id,
          content: 'Working hypothesis, mine only: the avoidance reads as protective rather than apathetic. Try naming it next time and watch for the flinch.',
        });
        processNotes++;
      }
    }
  }
  log(`${progressNotes} progress notes (${coSigned} co-signed, ${pending} awaiting ${rosa.name})`);
  log(`${processNotes} process notes — author-readable only`);

  // ── forms ─────────────────────────────────────────────────────────────
  let submitted = 0, flagged = 0;
  const zeros = () => Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`item_${i + 1}`, 0]));

  // Ten clients have an intake sitting unsubmitted — new referrals who have the
  // link and have not filled it in yet, which is the ordinary state of a
  // practice and the state the client-facing form pages are demonstrated in.
  for (const client of clients.slice(64)) {
    await issueForm(desk, { clientId: client.id, templateKey: 'intake' });
  }
  for (const client of clients.slice(46, 52)) {
    await issueForm(desk, { clientId: client.id, templateKey: 'intake' });
  }

  for (const client of clients.slice(0, 46)) {
    for (const key of ['consent-to-treat', 'wellbeing-check-in'] as const) {
      const request = await issueForm(desk, { clientId: client.id, templateKey: key });
      if (key === 'consent-to-treat') {
        // Six clients have consent outstanding — the banner needs something to show.
        if (clients.indexOf(client) % 8 === 3) continue;
        await submitForm(request.token, {
          read_policies: true, understand_limits: true, cancellation_policy: true,
          signature: `Test Client ${client.code.slice(3)}`,
        });
        submitted++;
        continue;
      }
      const answers: Record<string, number | string> = zeros();
      const severity = rand();
      for (let i = 1; i <= 8; i++) {
        answers[`item_${i}`] = severity > 0.75 ? 1 + Math.floor(rand() * 3) : Math.floor(rand() * 2);
      }
      // A handful flag the critical item. These are the alerts the demo shows.
      if (chance(0.08)) answers.item_9 = 1 + Math.floor(rand() * 2);
      answers.difficulty = pick(['not', 'somewhat', 'very', 'extremely']);
      const result = await submitForm(request.token, answers);
      submitted++;
      if (result.needsReview) flagged++;
    }
  }
  log(`${submitted} form submissions, ${flagged} flagged for review`);

  // ── a clinician takes a week off ──────────────────────────────────────
  const vacationFrom = addDays(TODAY, 14);
  const vacationTo = addDays(TODAY, 18);
  await prisma.availabilityOverride.create({
    data: {
      userId: nour.id, kind: 'unavailable',
      fromDate: new Date(`${vacationFrom}T00:00:00Z`),
      toDate: new Date(`${vacationTo}T00:00:00Z`),
      reason: 'Annual leave',
    },
  });
  const displaced = await prisma.appointment.count({
    where: {
      clinicianId: nour.id, status: { in: ['scheduled', 'confirmed'] },
      startAt: { gte: zonedToUtc(vacationFrom, 0), lt: zonedToUtc(addDays(vacationTo, 1), 0) },
    },
  });
  log(`${nour.name} is away ${vacationFrom} to ${vacationTo} — ${displaced} standing sessions to reschedule`);

  // ── waitlist ──────────────────────────────────────────────────────────
  for (const client of clients.slice(60, 68)) {
    await prisma.waitlistEntry.create({
      data: {
        clientId: client.id,
        weekdays: chance(0.5) ? [pick([1, 2, 3, 4, 5])] : [],
        earliestMinute: chance(0.5) ? 960 : null,
        note: 'Would take an earlier standing slot',
      },
    });
  }
  log('8 clients on the waitlist');

  // ── enquiries ─────────────────────────────────────────────────────────
  //
  // Counted, not drawn — same rule as the client loop above, and here it also
  // buys reproducibility for the referral report: a mix that shifts between
  // seeds is a report nobody can eyeball for correctness.
  //
  // Twenty converted, fifteen dead, five still open. The dead ones are the
  // point: a referral mix built only from clients would show which sources
  // send people and hide which sources send people who go elsewhere, and
  // those are the two halves of the same decision.
  const DISCARD_CODES = [
    'no_answer', 'not_a_fit', 'referred_out',
    'no_capacity', 'chose_elsewhere', 'duplicate', 'spam',
  ] as const;
  const nowMs = systemClock.now().getTime();
  const daysAgo = (d: number) => new Date(nowMs - d * 86_400_000);

  // The twenty who became clients, pointed at real records. `createdAt` sits a
  // few days before the client row, so "days from call to a client record" is
  // a spread rather than a column of zeroes.
  for (const [i, client] of clients.slice(40, 60).entries()) {
    const no = Number(client.code.slice(3));
    await prisma.inquiry.create({
      data: {
        firstName: 'Test',
        lastName: `Enquiry ${client.code}`,
        phone: `555-03${String(no).padStart(2, '0')}`,
        referralSource: REFERRAL_MIX[no % REFERRAL_MIX.length]!,
        // The same fact the client carries, because conversion copies it. A
        // mismatch here would be a broken fixture, not the deliberate
        // non-reconciliation with the *intake form's* answer (D-04).
        status: 'converted',
        clientId: client.id,
        takenById: frontDesk.id,
        createdAt: daysAgo(2 + (i % 12)),
      },
    });
  }

  // The fifteen that ended, across the whole vocabulary so the report has
  // every bar it can ever draw.
  for (let i = 0; i < 15; i++) {
    const called = 8 + i * 5;
    await prisma.inquiry.create({
      data: {
        firstName: 'Test',
        lastName: `Enquiry D${String(i + 1).padStart(2, '0')}`,
        phone: `555-04${String(i).padStart(2, '0')}`,
        referralSource: REFERRAL_MIX[(i * 3) % REFERRAL_MIX.length]!,
        status: 'discarded',
        discardReason: DISCARD_CODES[i % DISCARD_CODES.length]!,
        discardedAt: daysAgo(called - 3),
        takenById: frontDesk.id,
        createdAt: daysAgo(called),
      },
    });
  }

  // Five nobody has rung back yet — which is why the conversion rate divides
  // by everything and not just by the calls that reached an ending.
  for (let i = 0; i < 5; i++) {
    await prisma.inquiry.create({
      data: {
        firstName: 'Test',
        lastName: `Enquiry O${i + 1}`,
        phone: `555-05${String(i).padStart(2, '0')}`,
        referralSource: REFERRAL_MIX[(i * 2) % REFERRAL_MIX.length]!,
        note: i % 2 === 0 ? 'Mornings only' : 'Cannot do Tuesdays',
        takenById: frontDesk.id,
        createdAt: daysAgo(1 + i * 2),
      },
    });
  }
  log('40 enquiries — 20 converted, 15 discarded across all seven reason codes, 5 open');

  // ── the demo, guaranteed ──────────────────────────────────────────────
  //
  // The 60-second story needs one client who has both: an associate's progress
  // note awaiting countersignature, and one of that associate's process notes.
  // Left to the seed's dice this pairing is likely but not certain, so it is
  // constructed explicitly.
  const demoClient = clients.find((c) => c.clinicianId === priya.id);
  if (demoClient) {
    const demoAppt = await prisma.appointment.findFirst({
      where: { clientId: demoClient.id, status: 'completed', progressNote: null },
      orderBy: { startAt: 'desc' },
    });
    if (demoAppt) {
      const note = await createProgressNote(actor(priya), {
        appointmentId: demoAppt.id,
        content: [
          'Presenting: third session working on sleep and the pattern around Sunday evenings.',
          'Intervention: reviewed the sleep diary; agreed a wind-down routine to try this week.',
          'Plan: continue weekly. Review the diary next session.',
        ].join('\n\n'),
      });
      await signProgressNote(actor(priya), note.id);
    }
    await createProcessNote(actor(priya), {
      clientId: demoClient.id,
      content:
        'Mine only. I think the Sunday thing is about the job, not the sleep — but naming it too early last time made them retreat. Wait for them to say it.',
    });
    log(`demo client ${demoClient.code}: a note awaiting co-signature and a process note`);
  }

  // ── three break-glass events, for the auditor to find ─────────────────
  const breakGlassCases: [string, string][] = [
    ['client did not attend and could not be reached; welfare check', clients[2]!.id],
    ['subpoena response, ref 2026-114', clients[11]!.id],
    ['clinician on leave, client called the practice in distress', clients[23]!.id],
  ];
  for (const [reason, clientId] of breakGlassCases) {
    await guarded(
      { actor: actor(manager, reason), action: 'read', resource: 'client', resourceId: clientId, clientId },
      (tx) => tx.client.findUniqueOrThrow({ where: { id: clientId } }),
    );
  }

  // And one refusal that matters: the supervisor reaching for a process note.
  const supervisedNote = await prisma.processNote.findFirst({
    where: { authorId: priya.id, ...(demoClient ? { clientId: demoClient.id } : {}) },
  });
  if (supervisedNote) {
    await guarded(
      {
        actor: actor(rosa), action: 'read', resource: 'process_note',
        resourceId: supervisedNote.id, clientId: supervisedNote.clientId,
        target: { authorId: priya.id, authorSupervisorId: rosa.id },
      },
      async () => null,
    ).catch(() => undefined);
  }
  // The carrier, over the whole quarter. Everything already due goes out and
  // comes back `delivered`; the three failures seeded above are terminal, so
  // this cannot undo them, and messages scheduled into the future stay
  // `queued`, which is what a message nobody has sent yet actually is.
  for (const id of await dispatchOutbox(systemClock)) {
    await recordDeliveryReceipt(id, 'delivered', systemClock);
  }
  const delivered = await prisma.outboxMessage.count({ where: { deliveryState: 'delivered' } });
  const failed = await prisma.outboxMessage.count({ where: { deliveryState: 'failed' } });
  const stillQueued = await prisma.outboxMessage.count({ where: { deliveryState: 'queued' } });
  log(`${delivered} messages delivered, ${failed} failed, ${stillQueued} not yet due`);

  const auditRows = await prisma.auditEvent.count();
  log(`${breakGlassCases.length} break-glass events and 1 logged process-note refusal`);
  log(`${auditRows} audit rows in total`);

  console.log(`
Sign in as any of these (there is no password — the switcher is a dev tool):

  Front desk    ${frontDesk.name}
  Therapist     ${nour.name}
  Associate     ${priya.name}    (supervised by ${rosa.name})
  Supervisor    ${rosa.name}
  Manager       ${manager.name}
  Auditor       ${auditorUser.name}

The demo: sign in as ${rosa.name}, co-sign one of ${priya.name}'s progress notes,
then open the same client's process notes. Then sign in as ${auditorUser.name}
and find both events.
`);
}

await main();
await prisma.$disconnect();
