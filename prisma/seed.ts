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
const { availableSlots, materialiseSeries } = await import('../src/scheduling/booking');
const { bookGroupSession } = await import('../src/scheduling/groups');
const { createProgressNote, signProgressNote, coSignProgressNote, createProcessNote } =
  await import('../src/notes/service');
const { guarded } = await import('../src/auth/guard');
const { addDays, localDateOf, zonedToUtc } = await import('../src/time');
type BreakGlass = import('../src/auth/break-glass').BreakGlass;

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

async function main() {
  console.log('\nSeeding Stillwater Counseling — synthetic data only.\n');
  await resetDb();

  await prisma.practiceSettings.create({
    data: {
      id: 1, name: 'Stillwater Counseling', messagingName: 'Stillwater',
      standardFeeCents: 18_000, lateCancelWindowHours: 24, lateCancelFeeCents: 9_000,
      recurrenceHorizonDays: 90, continuityGapDays: 21,
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
  //
  // The order matters, because the roll below is drawn per appointment: two
  // sessions in the same minute sorted by `startAt` alone come back in
  // whatever order the table hands them over, and the quarter's statuses stop
  // being a property of the seed. The client code is the tiebreaker rather
  // than the id, because ids are generated fresh on every seed and sorting by
  // one is only as stable as the run that made it.
  const past = await prisma.appointment.findMany({
    where: { startAt: { lt: zonedToUtc(TODAY, 0) } },
    select: { id: true, clientId: true, clinicianId: true, startAt: true },
    orderBy: [{ startAt: 'asc' }, { client: { code: 'asc' } }],
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
        data: { status: 'no_show', chargeFeeCents: settings.lateCancelFeeCents },
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

  // ── and somebody is out for two hours, which is not the same thing ────
  //
  // The whole-week vacation was the only absence in the seed, so the code
  // paths that separate part of a day from all of it never ran against real
  // data. This one takes Rosa's 14:00 and leaves her 10:00 alone: the day
  // view says "out 13:00–15:00" rather than "away today", and the reschedule
  // work-list names one client rather than every client she sees that day.
  // Placed in the same forward window as the vacation: the seed's dates are
  // pinned so the screenshots reproduce, while the app reads the real clock,
  // so anything meant to appear on a work-list has to sit ahead of it.
  const offsite = addDays(TODAY, 16);
  await prisma.availabilityOverride.create({
    data: {
      userId: rosa.id, kind: 'unavailable',
      fromDate: new Date(`${offsite}T00:00:00Z`),
      toDate: new Date(`${offsite}T00:00:00Z`),
      startMinute: 13 * 60, endMinute: 15 * 60,
      reason: 'Offsite training',
    },
  });
  const partlyDisplaced = await prisma.appointment.count({
    where: {
      clinicianId: rosa.id, status: { in: ['scheduled', 'confirmed'] },
      startAt: { gte: zonedToUtc(offsite, 13 * 60), lt: zonedToUtc(offsite, 15 * 60) },
    },
  });
  log(`${rosa.name} is out 13:00–15:00 on ${offsite} — ${partlyDisplaced} session to move, not the day`);

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

  // ── a skills group: one hour, six people, six records ─────────────────
  //
  // The seed created no group session at all, so nothing the feature is made of
  // ever met real data: not the chip that collapses six attendee rows into one
  // hour, not `groupStatus`, not the roster page — which turned out to be the
  // one page in the app reading client records through an unguarded query, and
  // stayed that way because there was no id to open it with.
  //
  // Three Mondays: two behind TODAY so the hour carries real attendance, and
  // one ahead so the roster has a session that can still be cancelled. Mondays
  // because that is where this seed's biweekly clients pile up, so the busiest
  // day the screenshot spec picks is a day with a group on it.
  const groupDates = [QUARTER_START, '2026-08-10', addDays(TODAY, 6)];
  const groupIds: string[] = [];

  for (const date of groupDates) {
    const slots = await availableSlots({
      clinicianId: rosa.id, date, type: 'standard', modality: 'in_person',
    });
    // Late morning, so the group does not sit on top of the 09:00 the calendar
    // picture opens with.
    const startMinute = slots.find((m) => m >= 10 * 60);
    if (startMinute === undefined) {
      log(`no free hour for the skills group on ${date} — skipped`);
      continue;
    }

    // Attendees keep their own treating clinician and their own standing slot,
    // so anybody already booked at this hour is not free for the group. There
    // is no database constraint against booking a client twice at once — the
    // exclusion constraints are on the clinician and the room — so this is the
    // seed's job rather than the schema's.
    const busy = await prisma.appointment.findMany({
      where: {
        startAt: { lt: zonedToUtc(date, startMinute + 50) },
        endAt: { gt: zonedToUtc(date, startMinute) },
      },
      select: { clientId: true },
    });
    const taken = new Set(busy.map((b) => b.clientId));
    const attendees = clients.filter((c) => !taken.has(c.id)).slice(0, 6);
    if (attendees.length < 3) {
      log(`too few free clients for the skills group on ${date} — skipped`);
      continue;
    }

    const group = await bookGroupSession(actor(rosa), {
      clinicianId: rosa.id,
      clientIds: attendees.map((c) => c.id),
      date,
      startMinute,
      type: 'standard',
      modality: 'in_person',
      topic: 'Skills group',
    });
    groupIds.push(group.id);

    // Attendance on the two that have already happened. Statuses are set
    // directly, exactly as the quarter's history above is: this is fixture
    // construction rather than a simulation of front desk clicking through it.
    //
    // Deliberately mixed, because a uniform roster cannot show what
    // `groupStatus` is for: one person missing does not make the hour a
    // no-show, and the chip has to read `completed` while the row that sorts
    // first says otherwise.
    if (date < TODAY) {
      const roster = group.appointments;
      for (const [i, a] of roster.entries()) {
        const status = i === 0 ? 'no_show' : i === 1 ? 'late_cancelled' : 'completed';
        await prisma.appointment.update({
          where: { id: a.id },
          data: {
            status,
            // The fee recorded at the time of service, which is what the
            // superbill reads rather than the client's fee today — same
            // convention as the quarter's history above.
            chargeFeeCents: status === 'completed'
              ? feeByClient.get(a.clientId) ?? settings.standardFeeCents
              : settings.lateCancelFeeCents,
            ...(status === 'late_cancelled'
              ? { cancelledAt: zonedToUtc(date, startMinute - 60), cancelReason: 'unwell' }
              : {}),
          },
        });
      }
    }
  }
  log(`${groupIds.length} skills-group sessions (6 attendees each, one hour, one room)`);

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
    // Counted rather than asserted: the demo needs at least one note in the
    // queue, and the quarter's own associate notes may have left others there.
    const awaiting = await prisma.progressNote.count({
      where: { clientId: demoClient.id, signedAt: { not: null }, coSignedAt: null },
    });
    log(`demo client ${demoClient.code}: ${awaiting} note${awaiting === 1 ? '' : 's'} awaiting co-signature and a process note`);
  }

  // ── three break-glass events, for the auditor to find ─────────────────
  // Codes, not sentences. These used to read 'clinician on leave, client called
  // the practice in distress' — a clinical statement about the person the same
  // row names by id, seeded into an append-only table the auditor reads. One of
  // them carries a case reference, because that is the shape of detail this
  // field can safely hold.
  const breakGlassCases: [BreakGlass, string][] = [
    [{ reason: 'safety_check' }, clients[2]!.id],
    [{ reason: 'legal_request', ref: '2026-114' }, clients[11]!.id],
    [{ reason: 'clinician_unavailable' }, clients[23]!.id],
  ];
  for (const [breakGlass, clientId] of breakGlassCases) {
    await guarded(
      {
        actor: { ...actor(manager), breakGlass },
        action: 'read', resource: 'client', resourceId: clientId, clientId,
      },
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
