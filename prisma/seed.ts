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
const { bookAppointment, materialiseSeries } = await import('../src/scheduling/booking');
const { createProgressNote, signProgressNote, coSignProgressNote, createProcessNote } =
  await import('../src/notes/service');
const { guarded } = await import('../src/auth/guard');
const { addDays, localDateOf, zonedToUtc } = await import('../src/time');
const { fixedClock, DAY } = await import('../src/clock');
const { runReminderHorizon } = await import('../src/scheduling/reminders');
const { runNonResponseSweep } = await import('../src/scheduling/nonresponse');
const { confirmationRequired } = await import('../src/scheduling/confirmation');
const { confirmAppointment, declineAppointment } = await import('../src/portal/service');
const { waiveFee } = await import('../src/scheduling/lifecycle');
const { bookGroupSession } = await import('../src/scheduling/groups');
const { assertSeedMetrics } = await import('./metrics');
const { handleInboundReply } = await import('../src/messaging/inbound');

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

  const eligibleClients = new Map(
    (await prisma.client.findMany({
      select: { id: true, reminderPreference: true, email: true, phone: true },
    })).map((c) => [c.id, c]),
  );

  const everything = await prisma.appointment.findMany({
    select: { id: true, clientId: true, clinicianId: true, startAt: true, createdAt: true },
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
      await runReminderHorizon(clock);

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
          reminders: { some: {} },
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
          await declineAppointment(token, appt.id, { clock, acknowledgeFee: true });
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
  log(`${await prisma.appointmentReminder.count()} reminders queued across ${await prisma.outboxMessage.count()} outbox rows`);
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
    take: 4,
  });

  let understood = 0, unreadable = 0, optedOut = 0;
  const REPLIES: [string, 'yes' | 'stop' | 'unreadable'][] = [
    [withPhone[0]?.phone ?? '', 'yes'],
    [withPhone[1]?.phone ?? '', 'stop'],
    [withPhone[2]?.phone ?? '', 'unreadable'],
    [withPhone[3]?.phone ?? '', 'unreadable'],
  ];
  const WORDS: Record<string, string> = {
    yes: 'YES',
    stop: 'STOP',
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
