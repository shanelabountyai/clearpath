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

const url = process.env.DATABASE_URL ?? '';
if (/neon\.tech|rds\.amazonaws|supabase\.co|\.azure\./.test(url)) {
  throw new Error('Refusing to seed synthetic clinical data into a hosted database.');
}

const { prisma } = await import('../src/db');
const { actor } = await import('../src/test/harness');
const { TEMPLATES } = await import('../src/forms/fixtures');
const { publishTemplate, issueForm, submitForm } = await import('../src/forms/service');
const { materialiseSeries } = await import('../src/scheduling/booking');
const { createProgressNote, signProgressNote, coSignProgressNote, createProcessNote } =
  await import('../src/notes/service');
const { guarded } = await import('../src/auth/guard');
const { addDays, localDateOf, zonedToUtc } = await import('../src/time');

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

async function wipe() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

const log = (msg: string) => console.log(`  ${msg}`);

async function main() {
  console.log('\nSeeding Stillwater Counseling — synthetic data only.\n');
  await wipe();

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
  outer: for (const weekday of [1, 2, 3, 4, 5]) {
    for (const hour of [10, 14, 16]) {
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
