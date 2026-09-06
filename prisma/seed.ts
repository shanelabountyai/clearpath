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
const { bookAppointment, materialiseSeries, rescheduleAppointment } = await import('../src/scheduling/booking');
const { createProgressNote, signProgressNote, coSignProgressNote, createProcessNote } =
  await import('../src/notes/service');
const { guarded } = await import('../src/auth/guard');
const { addDays, localDateOf, utcToZoned, zonedToUtc } = await import('../src/time');
const { fixedClock, DAY } = await import('../src/clock');
const { runReminderHorizon } = await import('../src/scheduling/reminders');
const { runNonResponseSweep } = await import('../src/scheduling/nonresponse');
const { confirmationRequired } = await import('../src/scheduling/confirmation');
const { confirmAppointment, declineAppointment } = await import('../src/portal/service');
const { cancelAppointment, waiveFee } = await import('../src/scheduling/lifecycle');
const { bookGroupSession } = await import('../src/scheduling/groups');
const { assertSeedMetrics } = await import('./metrics');
const { setPassword } = await import('../src/auth/sessions');
const { DEMO_PASSWORD } = await import('../src/auth/demo');
const { handleInboundReply } = await import('../src/messaging/inbound');
const { runCarrier } = await import('../src/messaging/delivery');

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
/** A month before the quarter opened, so every standing session had notice. */
const BOOKED_AT = new Date(Date.parse(`${QUARTER_START}T12:00:00Z`) - 30 * 86_400_000);

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

  // Every staff account gets the same published demo password, set through
  // `setPassword` rather than by writing the column — the seed meets the same
  // hashing and the same complexity rule staff do, so a seed that drifted from
  // the policy would fail rather than quietly hash at some other cost.
  //
  // Nobody is pre-enrolled in a second factor. That is the more useful default
  // and the more honest one: the first sign-in for a clinical role walks
  // through mandatory enrolment, which is the part of the design worth seeing —
  // "not set up yet" is a step you must complete, never a way past the check.
  const staff = [...clinicians, frontDesk, manager, auditorUser];
  const hiredAt = fixedClock(BOOKED_AT);
  for (const person of staff) await setPassword(person.id, DEMO_PASSWORD, { clock: hiredAt });
  log(`${staff.length} staff accounts given the demo password, none enrolled in a second factor`);

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
            // Area code 555 is not a real NANP code and 555-01xx is the reserved
            // fictional block, so this is doubly fake — and, unlike the
            // seven-digit form it replaced, it is the length a carrier will
            // actually accept. The short form made every sms client fail
            // `plausibleDestination`, which was the seed being unrealistic
            // rather than the check being wrong.
            phone: `555-555-01${String(clientNo).padStart(2, '0')}`,
            emergencyContactName: `Emergency Contact ${clientNo}`,
            emergencyContactPhone: `555-555-02${String(clientNo).padStart(2, '0')}`,
            emergencyContactRelation: pick(['Partner', 'Parent', 'Sibling', 'Friend']),
            treatingClinicianId: clinician.id,
            // A third of the practice is on a sliding scale, which is normal.
            feeCents: chance(0.3) ? pick([6_000, 9_000, 12_000, 15_000]) : null,
            reminderPreference: chance(0.1) ? 'none' : chance(0.4) ? 'sms' : 'email',
            // P2-3. A minority have told the practice how many of the three
            // messages they want, and most people never touch a setting — so
            // the great majority stay on `full`, which is the point of it being
            // the default rather than a value anybody chose. The day-of-only
            // clients are the interesting slice: one message, three hours out,
            // and still fee-eligible like everybody else.
            reminderCadence: chance(0.12) ? 'day_of' : chance(0.1) ? 'day_before' : 'full',
            // P2. Every fifth client reads Spanish — and deliberately *not*
            // from the dice. A `chance()` call here consumes from the shared
            // stream and moves every roll after it, which last phase broke a
            // metric and an e2e spec that had nothing to do with the change.
            // Deriving it from the client number costs nothing and leaves the
            // rest of the quarter byte-identical.
            language: clientNo % 5 === 0 ? 'es' : 'en',
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
    const run = await materialiseSeries(desk, id, {
      from: QUARTER_START, horizonDays: 92 + HORIZON_DAYS,
      // The practice put the quarter on its books a month before it started,
      // which is what gives every session in it the five days' notice the
      // cadence needs. `createdAt` is not decoration here: it decides which
      // reminder stages were ever sendable, and therefore who can be charged.
      clock: fixedClock(BOOKED_AT),
    });
    created += run.created.length;
    skipped += run.skipped.length;
  }
  log(`${created} sessions materialised across the quarter and horizon${skipped ? ` (${skipped} slots unavailable)` : ''}`);

  // ── the awkward rows, booked before the simulation runs over them ─────
  //
  // Two fixtures the specs would otherwise assert about an empty set. Both are
  // created here rather than patched in afterwards, so the simulation puts them
  // through the same cadence, the same door and the same sweep as everything
  // else — a fixture that skipped the loop would prove nothing about the loop.

  // A group session with one attendee who drops out. The parent design says a
  // group is N appointments sharing a key, so one decline must cancel one
  // person and leave the room, the clinician and the co-attendees alone.
  const groupCandidates = (await prisma.client.findMany({
    where: { reminderPreference: { not: 'none' } },
    select: { id: true }, orderBy: { code: 'asc' }, take: 5,
  })).map((c) => c.id);
  const groupDate = addDays(TODAY, -7);
  const skillsGroup = await bookGroupSession(desk, {
    clinicianId: tom.id, clientIds: groupCandidates, date: groupDate, startMinute: 12 * 60,
    // Operational label for the staff calendar. It is on the wrong side of the
    // deny-list to ever leave the building, and no message body carries it.
    topic: 'Tuesday skills group', clock: fixedClock(BOOKED_AT),
  });
  const groupDecliner = skillsGroup.appointments[0]!.id;

  // A session booked three days out — inside the five-day window, so the first
  // stage was never a message anybody could have sent. It gets `d1` and `d0`
  // and is fee-eligible on two sends rather than three, which is the case the
  // eligibility rule exists to get right rather than to exclude.
  const lateBookingDate = addDays(TODAY, -11);
  const lateBooked = await bookAppointment(desk, {
    clientId: clients[1]!.id, clinicianId: nour.id, date: lateBookingDate, startMinute: 11 * 60,
    type: 'standard', modality: 'in_person',
    clock: fixedClock(new Date(zonedToUtc(lateBookingDate, 11 * 60).getTime() - 3 * DAY)),
  });

  // ── the quarter, simulated a day at a time ────────────────────────────
  //
  // Not a bulk update any more. The confirmation loop is due-date driven, so
  // the only way to produce data it would actually have produced is to run it:
  // every day of the quarter gets a horizon run in the morning, the clients who
  // are going to answer answer through their own door, and the sweep runs at
  // the end of the day. The reminder rows, the outbox rows, the portal links
  // and the audit trail are all real consequences rather than fixtures shaped
  // to look like consequences — which matters, because the success metrics are
  // queries against them.
  //
  // Attendance is still written directly. That is fixture construction, not a
  // simulation of front desk clicking through a quarter, and 900 three-step
  // transitions would make the seed unusable.

  const settings = await prisma.practiceSettings.findUniqueOrThrow({ where: { id: 1 } });
  const feeByClient = new Map(
    (await prisma.client.findMany({ select: { id: true, feeCents: true } })).map((c) => [c.id, c.feeCents]),
  );

  /**
   * The scripted client-behaviour mix: 70% confirm, 10% decline, 15% silent
   * but present, 5% silent and absent.
   *
   * Dealt from a cycle rather than from the dice, so the proportions are exact
   * and the fee total is hand-tallyable. A 5% behaviour sampled 1,100 times
   * lands anywhere between 3.7% and 6.4% often enough that "the rule is
   * over-firing" and "the seed rolled badly" would be indistinguishable — and
   * that spec is the one guarding against a policy that charges too many
   * people.
   */
  type Behaviour = 'confirm_early' | 'confirm_late' | 'decline_early' | 'decline_late' | 'silent_present' | 'silent_absent';
  const BEHAVIOUR_CYCLE: Behaviour[] = [
    'confirm_early', 'confirm_late', 'confirm_early', 'confirm_late', 'confirm_early',
    'confirm_late', 'confirm_early', 'silent_present', 'confirm_late', 'confirm_early',
    'decline_early', 'confirm_late', 'confirm_early', 'silent_present', 'confirm_late',
    'confirm_early', 'decline_late', 'confirm_late', 'silent_present', 'silent_absent',
  ];

  /** P1-5. The portal's four, reused rather than duplicated for the decline. */
  const DECLINE_REASONS = [
    'cannot_make_it', 'need_a_different_time', 'prefer_earlier', 'prefer_later',
  ] as const;

  const eligibleClients = new Map(
    (await prisma.client.findMany({
      select: { id: true, reminderPreference: true, email: true, phone: true },
    })).map((c) => [c.id, c]),
  );

  const everything = await prisma.appointment.findMany({
    select: { id: true, clientId: true, clinicianId: true, startAt: true, bookedAt: true },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
  });

  /** Who does what, decided once, before a single day is simulated. */
  const behaviour = new Map<string, Behaviour>();
  let eligibleCount = 0;
  for (const appt of everything) {
    const client = eligibleClients.get(appt.clientId)!;
    if (!confirmationRequired(client, appt, settings)) continue;
    behaviour.set(appt.id, BEHAVIOUR_CYCLE[eligibleCount % BEHAVIOUR_CYCLE.length]!);
    eligibleCount++;
  }

  // The two fixtures get their behaviour assigned rather than dealt, because
  // "at least one" is the point of them. Everything else takes the cycle.
  behaviour.set(groupDecliner, 'decline_early');
  for (const a of skillsGroup.appointments.slice(1)) behaviour.set(a.id, 'confirm_late');
  behaviour.set(lateBooked.id, 'silent_absent');

  /**
   * Sessions the practice moves on the day, after the client has been asked.
   *
   * The reschedule defect in one fixture: every message these clients received
   * named an hour that no longer exists, so a `pending` left standing would let
   * the sweep charge them for not answering a question the practice itself
   * withdrew. They are drawn from the silent set on purpose — a client who
   * answers cannot demonstrate the bug, because their answer, not their
   * silence, is what the sweep reads.
   *
   * Drawn from the quarter's second half so a full cadence has already run, and
   * moved in both directions on purpose, because the two produce different and
   * both-correct outcomes:
   *
   *   - **Later**, and the day-of stage for the new hour has not fallen yet, so
   *     the cadence asks again and a client who ignores *that* message is in
   *     exactly the position of anybody else. Charged, defensibly.
   *   - **Earlier**, and the new hour's stages are all in the past at the moment
   *     of the move, so nothing can be sent and the practice ends the day with
   *     a session it never asked about. Exempt — and this is the row that used
   *     to be an indefensible fee, charged on a message about an hour that no
   *     longer existed.
   *
   * Several will find the new hour taken and stay where they are, which is what
   * a real front desk finds too — the fixture is "some sessions were moved", not
   * "these exact ones".
   */
  const MOVES = 8;
  /** id → hours to shift the session by, alternating direction. */
  const toMove = new Map<string, number>();
  for (const appt of everything) {
    if (toMove.size >= MOVES) break;
    if (behaviour.get(appt.id) !== 'silent_absent') continue;
    if (localDateOf(appt.startAt) <= addDays(QUARTER_START, 45)) continue;
    if (localDateOf(appt.startAt) >= TODAY) continue;
    toMove.set(appt.id, toMove.size % 2 === 0 ? -2 : 2);
  }

  const startsOn = new Map<string, typeof everything>();
  for (const a of everything) {
    const d = localDateOf(a.startAt);
    startsOn.set(d, [...(startsOn.get(d) ?? []), a]);
  }

  /** The client's live door at that moment, minted by the cadence on a reminder. */
  const liveTokenFor = async (clientId: string, at: Date) =>
    (await prisma.portalLink.findFirst({
      where: { clientId, expiresAt: { gt: at } },
      orderBy: { expiresAt: 'desc' }, select: { token: true },
    }))?.token ?? null;

  const answered = { confirmed: 0, declined: 0 };
  let unanswerable = 0;
  let moved = 0;
  const attendance = { completed: 0, noShow: 0, cancelled: 0, lateCancelled: 0 };
  const clock = fixedClock(BOOKED_AT);

  // The loop opens five days before the quarter does, because the first week's
  // sessions were asked about the week before — starting it on day one would
  // leave everybody booked into early June unanswered for no reason but the
  // simulation's own edge, and that lands as silence in a fee count.
  for (let date = addDays(QUARTER_START, -5); date <= TODAY; date = addDays(date, 1)) {
    // The cadence runs hourly through the practice's day, not once at dawn.
    //
    // A stage falls due at the appointment's *own* hour, so a single morning
    // run keeps missing the day-of message for an afternoon session and would
    // have queued it after the client had already been and gone. Running it
    // hourly is also what a real deployment does — the job is idempotent and
    // due-date driven, so how often it runs is the caller's business and not
    // the cadence's.
    for (let hour = 8; hour <= 20; hour++) {
      clock.set(zonedToUtc(date, hour * 60));

      // Front desk moves an hour, after the client has been asked about it.
      //
      // Before the cadence run, so the re-ask — if the new hour leaves room for
      // one — happens on this same tick rather than a hypothetical later one.
      // The move waits for a *delivered* reminder rather than firing at a fixed
      // offset: a session moved before anybody was reached is not this defect,
      // it is an ordinary reschedule, and a fixture that produced those would
      // pass the metric below without ever exercising the rule.
      for (const [id, shiftHours] of toMove) {
        const appt = await prisma.appointment.findUniqueOrThrow({
          where: { id },
          select: {
            startAt: true, confirmation: true,
            reminders: { select: { outboxMessage: { select: { deliveryState: true } } } },
          },
        });
        if (appt.startAt.getTime() - clock.now().getTime() > 4 * 3600_000) continue;
        if (appt.confirmation !== 'pending') { toMove.delete(id); continue; }
        if (!appt.reminders.some((r) => r.outboxMessage?.deliveryState === 'delivered')) continue;

        const to = utcToZoned(new Date(appt.startAt.getTime() + shiftHours * 3600_000));
        try {
          await rescheduleAppointment(desk, id, {
            date: to.date, startMinute: to.minutes, clock,
          });
          moved++;
        } catch {
          // The room or the clinician is taken at the later hour. A real front
          // desk hits this too; the fixture is "some sessions were moved", not
          // "these exact three", so a refusal is a skipped row.
        }
        toMove.delete(id);
      }

      await runReminderHorizon(clock);

      // P2. The carrier, on the same hourly tick as the cadence: settle what it
      // has already answered, then hand over what the horizon just queued. The
      // simulated driver fails a deterministic slice — a few bad addresses, a
      // few provider outages that clear on retry — so the quarter contains real
      // undelivered messages rather than a uniformly perfect wire, which is the
      // only way the "never charge for a failed send" rule gets exercised by
      // data instead of asserted in the abstract.
      await runCarrier({ clock });

      // People answer the message they just got. Which is the whole reason
      // this is inside the hourly loop rather than pinned to an offset: a
      // client under the cadence cap has exactly one message, the day before,
      // and an "answers early" rule keyed to five days out finds nothing to
      // answer — the first draft of this loop silently turned every capped
      // client into a silent one and inflated the non-response count by a
      // third.
      const askedAndWaiting = await prisma.appointment.findMany({
        where: {
          confirmation: 'pending',
          startAt: { gt: clock.now() },
          // A message that never arrived is a message nobody can answer. Before
          // P2 this said `reminders: { some: {} }`, and the difference is the
          // whole point of the phase: a client whose number is dead used to
          // both "not answer" and get charged for it, in a simulation that
          // could never show either as a mistake.
          reminders: { some: { outboxMessage: { deliveryState: 'delivered' } } },
        },
        select: { id: true, clientId: true, startAt: true },
        orderBy: { startAt: 'asc' },
      });

      for (const appt of askedAndWaiting) {
        const b = behaviour.get(appt.id);
        if (!b || b.startsWith('silent')) continue;
        // The late half waits until the day of, which is what puts a decline
        // inside the late-cancel window and gives the fee something to apply
        // to. The early half answers the first message they get.
        const withinADay = appt.startAt.getTime() - clock.now().getTime() < DAY;
        if (b.endsWith('_late') && !withinADay) continue;

        const token = await liveTokenFor(appt.clientId, clock.now());
        if (!token) { unanswerable++; continue; }

        if (b.startsWith('confirm')) {
          await confirmAppointment(token, appt.id, { clock });
          answered.confirmed++;
        } else {
          // Through the real door, so `classifyCancellation` — not this seed —
          // decides whether it was late, and the fee follows from the clock.
          // P1-5: with one of the four codes the reschedule request uses, dealt
          // round-robin so the report has all of them to show.
          await declineAppointment(token, appt.id, {
            clock, acknowledgeFee: true,
            reason: DECLINE_REASONS[answered.declined % DECLINE_REASONS.length]!,
          });
          answered.declined++;
        }
      }
    }

    // Evening: what actually happened in the rooms. Written before the sweep,
    // because a client who turned up must be off `scheduled` by the time it
    // runs — that ordering *is* the guarantee, not a convenience.
    if (date < TODAY) {
      clock.set(zonedToUtc(date, 21 * 60));
      for (const appt of startsOn.get(date) ?? []) {
        const b = behaviour.get(appt.id);
        // The 5% who said nothing and did not come are left exactly as they
        // are. The sweep is what turns them into a no-show and a fee, and if it
        // stops doing that this seed stops containing any.
        if (b === 'silent_absent') continue;
        if (b?.startsWith('decline')) continue; // already cancelled at the door

        const current = await prisma.appointment.findUniqueOrThrow({
          where: { id: appt.id }, select: { status: true },
        });
        if (current.status === 'cancelled' || current.status === 'late_cancelled') continue;

        // Clients the practice never asked keep the old dice: a practice has
        // absences that have nothing to do with a text message.
        const roll = b ? 1 : rand();
        if (roll < 0.05) {
          await prisma.appointment.update({
            where: { id: appt.id },
            data: { status: 'late_cancelled', cancelledAt: new Date(appt.startAt.getTime() - 3 * 3600_000), chargeFeeCents: settings.lateCancelFeeCents, cancelReason: 'client cancelled' },
          });
          attendance.lateCancelled++;
        } else if (roll < 0.09) {
          await prisma.appointment.update({
            where: { id: appt.id },
            data: { status: 'cancelled', cancelledAt: new Date(appt.startAt.getTime() - 5 * 86_400_000), cancelReason: 'client rescheduled' },
          });
          attendance.cancelled++;
        } else if (roll < 0.12) {
          await prisma.appointment.update({
            where: { id: appt.id },
            // The no-show policy, which is its own field — a missed hour and a
            // cancellation with some notice are not the same event.
            data: { status: 'no_show', chargeFeeCents: settings.noShowFeeCents },
          });
          attendance.noShow++;
        } else {
          await prisma.appointment.update({
            where: { id: appt.id },
            data: { status: 'completed', chargeFeeCents: feeByClient.get(appt.clientId) ?? settings.standardFeeCents },
          });
          attendance.completed++;
        }
      }
    }

    // End of day: silence becomes an answer, twenty minutes past each start.
    clock.set(zonedToUtc(addDays(date, 1), 0));
    await runNonResponseSweep(clock);
  }

  const swept = await prisma.appointment.count({ where: { confirmation: 'no_response' } });
  const autoNoShows = await prisma.appointment.count({ where: { confirmation: 'no_response', status: 'no_show' } });
  log(`${eligibleCount} sessions the practice could ask about; ${answered.confirmed} confirmed, ${answered.declined} declined${unanswerable ? ` (${unanswerable} unreachable at the moment they would have answered)` : ''}`);
  log(`${moved} sessions moved on the day, after the client had already been asked about them`);
  log(`${await prisma.appointmentReminder.count()} reminders queued across ${await prisma.outboxMessage.count()} outbox rows`);
  const deliveredCount = await prisma.outboxMessage.count({ where: { deliveryState: 'delivered' } });
  const failedCount = await prisma.outboxMessage.count({ where: { deliveryState: 'failed' } });
  const retried = await prisma.outboxMessage.count({ where: { attempts: { gt: 1 } } });
  log(`${deliveredCount} delivered, ${failedCount} never arrived, ${retried} took more than one attempt`);
  log(`${swept} went unanswered, of which ${autoNoShows} became a no-show and a fee`);
  log(`${attendance.completed} completed, ${attendance.cancelled + attendance.lateCancelled + attendance.noShow} cancelled, late-cancelled or missed by clients the practice never asked`);

  const completed = await prisma.appointment.findMany({
    where: { status: 'completed' },
    select: { id: true, clientId: true, clinicianId: true, startAt: true },
    orderBy: { startAt: 'asc' },
  });

  // A slice of the near future is confirmed at the desk; the rest stays merely
  // scheduled. Staff-side `status`, which is a different fact from whether the
  // client answered — the demo needs both axes visible at once.
  await prisma.appointment.updateMany({
    where: {
      startAt: { gte: zonedToUtc(TODAY, 0), lt: zonedToUtc(addDays(TODAY, 4), 0) },
      status: 'scheduled',
    },
    data: { status: 'confirmed' },
  });

  // ── clients who texted back in words ──────────────────────────────────
  //
  // P1-3. The tap-link is the response this feature asked for, and some people
  // reply anyway. Three of them here, each landing somewhere different: one
  // understood and acted on, one asking to be left alone, and two the system
  // could not read — which is the only kind that reaches a person.
  const inboundAt = fixedClock(new Date(zonedToUtc(TODAY, 9 * 60).getTime() - 2 * 3_600_000));
  const withPhone = await prisma.client.findMany({
    where: { phone: { not: null }, reminderPreference: { not: 'none' } },
    select: { id: true, phone: true },
    orderBy: { code: 'desc' },
    take: 3,
  });
  // One of them reads Spanish, chosen rather than hoped for: the branch worth
  // having in the seed is the Spanish auto-reply, and leaving it to which
  // clients happen to sort last would mean the demo has it on some runs.
  const spanishSpeaker = await prisma.client.findFirst({
    where: { phone: { not: null }, reminderPreference: { not: 'none' }, language: 'es' },
    select: { id: true, phone: true },
    orderBy: { code: 'asc' },
  });
  if (spanishSpeaker) withPhone.push(spanishSpeaker);

  let understood = 0, unreadable = 0, optedOut = 0;
  const REPLIES: [string, 'yes' | 'stop' | 'unreadable' | 'unreadable_es'][] = [
    [withPhone[0]?.phone ?? '', 'yes'],
    [withPhone[1]?.phone ?? '', 'stop'],
    [withPhone[2]?.phone ?? '', 'unreadable'],
    [withPhone[3]?.phone ?? '', 'unreadable_es'],
  ];
  const WORDS: Record<string, string> = {
    yes: 'YES',
    stop: 'STOP',
    // A Spanish speaker writing a sentence, which is the case the whole
    // classified-and-discarded design exists for.
    unreadable_es: '¿Podría llamarme mañana? No estoy seguro.',
    // Deliberately something no keyword list should ever guess at. The point of
    // the fixture is the branch where the practice telephones rather than
    // decides — and the words below exist in this file for one instant and are
    // never written anywhere, which is the feature.
    unreadable: 'sorry, can I call you tomorrow about this?',
  };
  for (const [from, kind] of REPLIES) {
    if (!from) continue;
    const reply = await handleInboundReply({ from, body: WORDS[kind]! }, { clock: inboundAt });
    if (reply.classification === 'unparsed') unreadable++;
    else if (reply.classification === 'opt_out') optedOut++;
    else understood++;
  }
  log(`${understood + unreadable + optedOut} clients texted back: ${understood} understood, ${optedOut} asked to stop, ${unreadable} for front desk to ring`);

  // ── the rest of the awkward rows ──────────────────────────────────────

  // Three clients the practice may never charge, each with an absence on the
  // record. Without them, "the exemption holds" is asserted about a set that
  // happens to be empty, which is the weakest kind of green.
  const neverAsked = await prisma.client.findMany({
    where: { reminderPreference: 'none' }, select: { id: true }, orderBy: { code: 'asc' }, take: 3,
  });
  let exemptAbsences = 0;
  for (const c of neverAsked) {
    const missed = await prisma.appointment.findFirst({
      where: { clientId: c.id, status: 'completed', startAt: { lt: zonedToUtc(TODAY, 0) } },
      orderBy: { startAt: 'desc' },
    });
    if (!missed) continue;
    await prisma.appointment.update({
      where: { id: missed.id },
      // Front desk marked it. The fee is the practice's ordinary no-show
      // policy, and `confirmation` stays `not_required` — nobody asked them
      // anything, so there is nothing they failed to answer.
      data: { status: 'no_show', chargeFeeCents: settings.noShowFeeCents },
    });
    exemptAbsences++;
  }
  log(`${exemptAbsences} absences by clients on "no messages" — recorded, never chargeable to this policy`);

  // One waived fee, so the reversal has something to show and the audit trail
  // has the "was 9000 cents" row an auditor would go looking for.
  const toWaive = await prisma.appointment.findFirst({
    where: { confirmation: 'no_response', status: 'no_show', chargeFeeCents: { not: null } },
    orderBy: { startAt: 'desc' },
  });
  if (toWaive) {
    await waiveFee(admin, toWaive.id, 'practice_error', {
      clock: fixedClock(new Date(toWaive.startAt.getTime() + 2 * DAY)),
    });
    log('1 automatic fee waived by the practice manager, with the original amount on the record');
  }

  const groupNow = await prisma.appointment.findMany({
    where: { groupSessionId: skillsGroup.id }, select: { status: true },
  });
  log(`1 group session on ${groupDate}: ${groupNow.filter((a) => a.status !== 'cancelled' && a.status !== 'late_cancelled').length} attended, 1 declined through their own link`);
  log(`1 session booked 3 days out on ${lateBookingDate} — d5 was never sendable, and it is still fee-eligible`);

  // ── notes ─────────────────────────────────────────────────────────────
  //
  // Only sessions a clinician ran for a client they actually treat. A group
  // session is the exception that makes the rule visible: five attendees in
  // one room with one clinician, four of whom belong to somebody else's
  // caseload — and `create: 'treating'` refuses a note for a client you do not
  // treat, which is the matrix being right rather than the seed being awkward.
  const treatedBy = new Map(
    (await prisma.client.findMany({ select: { id: true, treatingClinicianId: true } }))
      .map((c) => [c.id, c.treatingClinicianId]),
  );
  const byClinician = new Map<string, typeof completed>();
  for (const a of completed) {
    if (treatedBy.get(a.clientId) !== a.clinicianId) continue;
    byClinician.set(a.clinicianId, [...(byClinician.get(a.clinicianId) ?? []), a]);
  }

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

  // ── cancellations that came in since ──────────────────────────────────
  //
  // P2-2. The quarter's own declines land where the simulation stops — the
  // loop ends at "today", so the only hours it frees ahead of itself are the
  // one or two answered on the last tick. That is an artefact of where the
  // simulation ends rather than a fact about a practice: a real one on any
  // given morning is looking at several freed hours in the coming weeks, from
  // clients who rang, replied, or told the desk in the room.
  //
  // So a handful of the horizon's sessions are given back, through the same
  // `cancelAppointment` the desk uses, spread across the month so the list has
  // a range of notice on it rather than one band. All are far enough out to be
  // ordinary cancellations: none of them is inside the late-cancel window and
  // none of them carries a fee, which is checked below rather than assumed.
  const horizon = await prisma.appointment.findMany({
    where: {
      status: { in: ['scheduled', 'confirmed'] },
      startAt: { gte: zonedToUtc(addDays(TODAY, 6), 0), lt: zonedToUtc(addDays(TODAY, 27), 0) },
      // Not the ones a vacation already displaced; those are a different
      // work-list, and an hour a clinician is not working is not one to sell.
      NOT: {
        clinicianId: nour.id,
        startAt: { gte: zonedToUtc(vacationFrom, 0), lt: zonedToUtc(addDays(vacationTo, 1), 0) },
      },
    },
    select: { id: true, startAt: true, clinicianId: true },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
  });

  const deskActor = actor(frontDesk);
  const cancelClock = fixedClock(zonedToUtc(TODAY, 9 * 60));
  const givenBack: string[] = [];
  // Every fourth one, so they spread across the month and across clinicians
  // instead of clustering in one week.
  for (let i = 0; i < horizon.length && givenBack.length < 6; i += 4) {
    const appt = horizon[i]!;
    await cancelAppointment(deskActor, appt.id, {
      clock: cancelClock,
      // Half of them answered the reminder and half rang the desk. The
      // distinction is the whole reason this list is not "declines": the hour
      // is just as empty either way.
      ...(givenBack.length % 2 === 0
        ? { confirmation: 'declined' as const, reason: 'client declined' }
        : { reason: 'client rescheduled' }),
    });
    givenBack.push(appt.id);
  }

  // One inside the vacation week, which must *not* become an offerable hour:
  // the clinician is not there to work it. Without this the freed-hour list and
  // the vacation work-list would describe the same absence in opposite words.
  const inVacation = await prisma.appointment.findFirst({
    where: {
      clinicianId: nour.id, status: { in: ['scheduled', 'confirmed'] },
      startAt: { gte: zonedToUtc(vacationFrom, 0), lt: zonedToUtc(addDays(vacationTo, 1), 0) },
    },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (inVacation) {
    await cancelAppointment(deskActor, inVacation.id, { clock: cancelClock, reason: 'clinician unavailable' });
  }

  const chargedGiveBacks = await prisma.appointment.count({
    where: { id: { in: givenBack }, chargeFeeCents: { not: null } },
  });
  log(`${givenBack.length} sessions given back across the coming month — ${chargedGiveBacks} of them chargeable`);

  // ── waitlist ──────────────────────────────────────────────────────────
  const onList = new Set<string>();
  for (const client of clients.slice(60, 68)) {
    await prisma.waitlistEntry.create({
      data: {
        clientId: client.id,
        weekdays: chance(0.5) ? [pick([1, 2, 3, 4, 5])] : [],
        earliestMinute: chance(0.5) ? 960 : null,
        note: 'Would take an earlier standing slot',
      },
    });
    onList.add(client.id);
  }

  // P2-2. And at least one of them has to be able to take an hour the quarter
  // actually freed, or the freed-hour list demonstrates nothing.
  //
  // Left to the dice this is unlikely rather than merely uncertain, and the
  // reason is the continuity rule: a match needs a waiting client *of the same
  // clinician* whose window covers the freed hour, and eight entries spread
  // over six clinicians with a random weekday and a 4pm floor will usually miss
  // every time. The first run of this seed produced two freed hours and no
  // candidate for either. Same treatment as the demo client below: constructed
  // explicitly, from the openings the simulation produced rather than from a
  // slot invented to be matched.
  const freedAhead = await prisma.appointment.findMany({
    where: {
      status: { in: ['cancelled', 'late_cancelled'] },
      startAt: { gt: zonedToUtc(TODAY, 0) },
    },
    select: { startAt: true, clinicianId: true, clientId: true },
    orderBy: { startAt: 'asc' },
  });
  let matched = 0;
  for (const slot of freedAhead) {
    // Only the first few. A practice where every freed hour has somebody
    // waiting for it is not a practice, it is a fixture — and it would hide the
    // case the list has to handle honestly: an hour nobody can take, which
    // stays on the screen rather than disappearing for being inconvenient.
    if (matched >= 3) break;
    const { minutes, weekday } = utcToZoned(slot.startAt);
    const candidate = clients.find(
      (c) => c.clinicianId === slot.clinicianId && c.id !== slot.clientId && !onList.has(c.id),
    );
    if (!candidate) continue;
    onList.add(candidate.id);
    matched++;
    await prisma.waitlistEntry.create({
      data: {
        clientId: candidate.id,
        weekdays: [weekday],
        // A window around the hour rather than the hour itself: a waiting
        // client with a taste in times, not one reverse-engineered to fit.
        earliestMinute: Math.max(0, minutes - 120),
        latestMinute: Math.min(1439, minutes + 120),
        note: 'Would take an earlier standing slot',
      },
    });
  }
  log(`${onList.size} clients on the waitlist — ${matched} of them can take an hour the quarter freed`);

  // ── the demo, guaranteed ──────────────────────────────────────────────
  //
  // The 60-second story needs one client who has both: an associate's progress
  // note awaiting countersignature, and one of that associate's process notes.
  // Left to the seed's dice this pairing is likely but not certain, so it is
  // constructed explicitly.
  const demoClient = clients.find((c) => c.clinicianId === priya.id);
  if (demoClient) {
    // Only if the dice have not already produced one. This block guarantees the
    // demo pairing *exists*; it is not meant to add a second copy when the
    // quarter already dealt one, and a client sitting in the co-signature queue
    // twice makes the sixty-second story read like a bug. Adding the cadence
    // setting moved the seed's random stream, the dice landed on a note here
    // for the first time, and the e2e spec that co-signs one and expects the
    // queue to empty found the other one still there.
    const alreadyWaiting = await prisma.progressNote.count({
      where: { clientId: demoClient.id, signedAt: { not: null }, coSignedAt: null },
    });
    const demoAppt = alreadyWaiting > 0 ? null : await prisma.appointment.findFirst({
      // Their own clinician's session, not one they merely sat in: a group
      // attendee's hour belongs to whoever ran the group, and only the
      // treating clinician writes into a record.
      where: { clientId: demoClient.id, clinicianId: priya.id, status: 'completed', progressNote: null },
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
    log(`demo client ${demoClient.code}: a note awaiting co-signature and a process note`
      + (alreadyWaiting > 0 ? ' (the quarter already dealt the note)' : ''));
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
  // ── the quarter, against its own success metrics ──────────────────────
  //
  // Run here rather than left to a spec, because every one of them is a
  // statement about the whole simulated quarter — and because a seed that can
  // produce data violating its own eligibility rule will, quietly, on the run
  // nobody watched. It throws rather than warns.
  console.log('');
  await assertSeedMetrics(log);
  console.log('');

  const auditRows = await prisma.auditEvent.count();
  log(`${breakGlassCases.length} break-glass events and 1 logged process-note refusal`);
  log(`${auditRows} audit rows in total`);

  const account = (u: { name: string; email: string }) => `${u.name.padEnd(17)}${u.email}`;
  console.log(`
Sign in with the password  ${DEMO_PASSWORD}

  Front desk    ${account(frontDesk)}
  Therapist     ${account(nour)}
  Associate     ${account(priya)}  (supervised by ${rosa.name})
  Supervisor    ${account(rosa)}
  Manager       ${account(manager)}
  Auditor       ${account(auditorUser)}

Front desk and auditor sign in with the password alone. The three clinical roles
and the practice manager are asked for a second factor, and none of them is
enrolled yet — the first sign-in walks through setting one up, which is the part
worth watching: "not set up yet" is a step you have to finish, not a way past it.
You will need an authenticator app, or the code the e2e suite computes for one.

The demo: sign in as ${rosa.name}, co-sign one of ${priya.name}'s progress notes,
then open the same client's process notes. Then sign in as ${auditorUser.name}
and find both events.
`);
}

await main();
await prisma.$disconnect();
