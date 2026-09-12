import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, fixedClock } from '../clock';
import { prisma } from '../db';
import { Conflict, Forbidden } from '../errors';
import {
  amendProgressNote, coSignProgressNote, getProcessNote, getProgressNote, listProgressNotes,
} from '../notes/service';
import type { Role } from '../auth/permissions';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { getClient } from '../clients/repository';
import { indiscreetTerms } from '../messaging/outbox';
import { whenLong } from '../strings';
import { zonedToUtc } from '../time';
import {
  TRANSITIONS, abandonedNotesByDeparture, assertTransition, canTransition, cancelDeparture, decideAssignment,
  departureBlockers, departureWorklist, executeDeparture, getDeparturePlan, ownDrafts, planDeparture,
  previewProcessNotePurge, runProcessNotePurge, setReceivingSupervisor,
  type DepartureStatus,
} from './departure';

const STATUSES = Object.keys(TRANSITIONS) as DepartureStatus[];

describe('the departure state machine', () => {
  it('goes from a plan to exactly two endings', () => {
    expect(canTransition('planned', 'executed')).toBe(true);
    expect(canTransition('planned', 'cancelled')).toBe(true);
  });

  it('has no way back to planned, from either ending', () => {
    expect(canTransition('executed', 'planned')).toBe(false);
    expect(canTransition('cancelled', 'planned')).toBe(false);
  });

  it('cannot cancel a departure that already happened, or execute a cancelled one', () => {
    expect(canTransition('executed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'executed')).toBe(false);
  });

  it('does not let a status become itself — a re-plan is a new row', () => {
    for (const s of STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('refuses every illegal transition with a Conflict, never a silent no-op', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (canTransition(from, to)) {
          expect(() => assertTransition(from, to)).not.toThrow();
          continue;
        }
        expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(Conflict);
      }
    }
  });

  it('names the refusal with the same code the session lifecycle uses', () => {
    try {
      assertTransition('executed', 'cancelled');
      expect.unreachable();
    } catch (e) {
      expect((e as Conflict).code).toBe('bad_transition');
      // No PHI, no names: the message says what a status did, and nothing else.
      expect((e as Conflict).message).toBe('A executed departure cannot become cancelled');
    }
  });
});

// ─────────────────── what the database refuses (Phase 2) ───────────────────

const T0 = new Date('2026-09-30T12:00:00Z');

/** A clinician who has left, with the departure row that says so. */
async function departed(opts: { status?: 'planned' | 'executed' } = {}) {
  const leaver = await makeUser('therapist');
  const manager = await makeUser('admin');
  const status = opts.status ?? 'executed';
  const departure = await prisma.departure.create({
    data: {
      userId: leaver.id,
      plannedById: manager.id,
      noticeAt: new Date('2026-09-01T09:00:00Z'),
      lastDayOn: new Date('2026-09-30T00:00:00Z'),
      status,
      executedAt: status === 'executed' ? T0 : null,
    },
  });
  return { leaver, manager, departure };
}

async function processNoteOf(authorId: string, clientId: string, unreachableSince?: Date) {
  return prisma.processNote.create({
    data: { authorId, clientId, content: 'Private working thinking.', unreachableSince: unreachableSince ?? null },
  });
}

describe('the departure row (P0-1)', () => {
  beforeEach(async () => {
    await resetDb();
    await settings();
  });
  afterAll(() => prisma.$disconnect());

  it('allows a person only one departure at a time, and a second one later', async () => {
    const { leaver, manager } = await departed({ status: 'planned' });

    const second = {
      userId: leaver.id, plannedById: manager.id,
      noticeAt: new Date('2027-01-04T09:00:00Z'), lastDayOn: new Date('2027-02-01T00:00:00Z'),
    };
    await expect(prisma.departure.create({ data: second })).rejects.toThrow(/departure_one_open_per_user/);

    // Terminal rows are outside the partial index: leaving twice in a career is
    // the P2 returning-clinician case, and a plain unique would forbid it.
    await prisma.departure.updateMany({ where: { userId: leaver.id }, data: { status: 'cancelled' } });
    await expect(prisma.departure.create({ data: second })).resolves.toBeTruthy();
  });

  it('refuses a last day before the notice', async () => {
    const leaver = await makeUser('therapist');
    const manager = await makeUser('admin');
    await expect(
      prisma.departure.create({
        data: {
          userId: leaver.id, plannedById: manager.id,
          noticeAt: new Date('2026-09-30T09:00:00Z'), lastDayOn: new Date('2026-09-01T00:00:00Z'),
        },
      }),
    ).rejects.toThrow(/departure_last_day_after_notice/);
  });

  it('refuses an execution with no date, and a date with no execution', async () => {
    const { departure } = await departed({ status: 'planned' });

    await expect(
      prisma.departure.update({ where: { id: departure.id }, data: { status: 'executed' } }),
    ).rejects.toThrow(/departure_execution_is_complete/);

    await expect(
      prisma.departure.update({ where: { id: departure.id }, data: { executedAt: T0 } }),
    ).rejects.toThrow(/departure_execution_is_complete/);
  });
});

describe('the disposition row (P0-1, goal 2)', () => {
  beforeEach(async () => {
    await resetDb();
    await settings();
  });

  const assignment = async (over: Record<string, unknown> = {}) => {
    const { leaver, manager, departure } = await departed({ status: 'planned' });
    const client = await makeClient(leaver.id);
    return prisma.departureAssignment.create({
      data: {
        departureId: departure.id, clientId: client.id, decidedById: manager.id,
        disposition: 'transfer', ...over,
      },
    });
  };

  it('refuses a transfer with nobody receiving it', async () => {
    await expect(assignment({ disposition: 'transfer' }))
      .rejects.toThrow(/departure_transfer_has_a_receiver/);
  });

  it('refuses a receiving clinician on a disposition that is not a transfer', async () => {
    const beth = await makeUser('therapist');
    await expect(assignment({ disposition: 'discharge', receivingClinicianId: beth.id }))
      .rejects.toThrow(/departure_transfer_has_a_receiver/);
  });

  it('takes a transfer with a receiver, and a discharge with nobody', async () => {
    const beth = await makeUser('therapist');
    await expect(assignment({ disposition: 'transfer', receivingClinicianId: beth.id })).resolves.toBeTruthy();
    await expect(assignment({ disposition: 'discharge' })).resolves.toBeTruthy();
  });

  it('refuses a referral destination on anything but referred_out, and allows one without', async () => {
    const referrer = await prisma.referrer.create({ data: { practice: 'Riverside Surgery' } });
    await expect(assignment({ disposition: 'discharge', referredOutToId: referrer.id }))
      .rejects.toThrow(/departure_destination_only_when_referred_out/);

    // A practice down the road that is not in the contact list is an honest row.
    await expect(assignment({ disposition: 'referred_out' })).resolves.toBeTruthy();
    await expect(assignment({ disposition: 'referred_out', referredOutToId: referrer.id })).resolves.toBeTruthy();
  });

  it('holds one decision per client per departure', async () => {
    const first = await assignment({ disposition: 'discharge' });
    await expect(
      prisma.departureAssignment.create({
        data: {
          departureId: first.departureId, clientId: first.clientId,
          decidedById: first.decidedById, disposition: 'referred_out',
        },
      }),
    ).rejects.toThrow(/departureId_clientId/);
  });
});

describe('the note nobody may sign (P0-4b)', () => {
  beforeEach(async () => {
    await resetDb();
    await settings();
  });

  /** A draft with an appointment behind it, authored by the departing clinician. */
  async function draft() {
    const { leaver, departure } = await departed();
    const client = await makeClient(leaver.id);
    const room = await makeRoom();
    const appt = await prisma.appointment.create({
      data: {
        clientId: client.id, clinicianId: leaver.id, roomId: room.id,
        startAt: new Date('2026-09-28T17:00:00Z'), endAt: new Date('2026-09-28T17:50:00Z'),
        type: 'standard', modality: 'in_person',
      },
    });
    const note = await prisma.progressNote.create({
      data: { appointmentId: appt.id, clientId: client.id, authorId: leaver.id, content: 'Session went…' },
    });
    return { note, departure, leaver, client };
  }

  it('refuses the status without the departure that caused it', async () => {
    const { note } = await draft();
    await expect(
      prisma.progressNote.update({ where: { id: note.id }, data: { status: 'abandoned' } }),
    ).rejects.toThrow(/progress_note_abandonment_has_a_cause/);
  });

  it('refuses a departure named on a note that is not abandoned', async () => {
    const { note, departure } = await draft();
    await expect(
      prisma.progressNote.update({ where: { id: note.id }, data: { abandonedByDepartureId: departure.id } }),
    ).rejects.toThrow(/progress_note_abandonment_has_a_cause/);
  });

  it('abandons a draft, and keeps the content', async () => {
    const { note, departure } = await draft();
    const abandoned = await prisma.progressNote.update({
      where: { id: note.id },
      data: { status: 'abandoned', abandonedByDepartureId: departure.id },
    });
    expect(abandoned.content).toBe('Session went…');
    expect(abandoned.signedAt).toBeNull();
  });

  it('never lets a signed note be abandoned — that would retire a signature', async () => {
    const { note, departure } = await draft();
    await prisma.progressNote.update({ where: { id: note.id }, data: { status: 'signed', signedAt: T0 } });
    await expect(
      prisma.progressNote.update({
        where: { id: note.id },
        data: { status: 'abandoned', abandonedByDepartureId: departure.id },
      }),
    ).rejects.toThrow(/only a draft can be abandoned/);
  });

  it('is terminal: an abandoned note goes nowhere, signed least of all', async () => {
    const { note, departure } = await draft();
    await prisma.progressNote.update({
      where: { id: note.id },
      data: { status: 'abandoned', abandonedByDepartureId: departure.id },
    });

    for (const status of ['draft', 'signed', 'cosigned'] as const) {
      await expect(
        prisma.progressNote.update({
          where: { id: note.id },
          data: { status, abandonedByDepartureId: status === 'draft' ? null : undefined },
        }),
        status,
      ).rejects.toThrow();
    }
  });

  it('freezes the content it retained', async () => {
    const { note, departure } = await draft();
    await prisma.progressNote.update({
      where: { id: note.id },
      data: { status: 'abandoned', abandonedByDepartureId: departure.id },
    });
    await expect(
      prisma.progressNote.update({ where: { id: note.id }, data: { content: 'tidied up' } }),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses to be co-signed or amended through the service', async () => {
    const { note, departure, leaver } = await draft();
    const supervisor = await makeUser('supervisor');
    await prisma.user.update({ where: { id: leaver.id }, data: { supervisorId: supervisor.id } });
    await prisma.progressNote.update({
      where: { id: note.id },
      data: { status: 'abandoned', abandonedByDepartureId: departure.id },
    });

    await expect(coSignProgressNote(actor(supervisor), note.id))
      .rejects.toMatchObject({ code: 'note_abandoned' });
    await expect(amendProgressNote(actor(supervisor), note.id, 'for the record'))
      .rejects.toMatchObject({ code: 'note_abandoned' });
  });
});

describe('the process notes nobody can reach (P0-10)', () => {
  beforeEach(async () => {
    await resetDb();
    await settings({ processNoteAfterDepartureDays: 30 });
  });

  it('refuses to destroy a process note whose author is still here', async () => {
    const alex = await makeUser('therapist');
    const client = await makeClient(alex.id);
    const note = await processNoteOf(alex.id, client.id);

    await expect(prisma.processNote.deleteMany({ where: { id: note.id, authorId: alex.id } }))
      .rejects.toThrow(/only be destroyed after its author departed/);
  });

  it('destroys nothing before the window, and the note itself after it', async () => {
    const { leaver, departure } = await departed();
    const client = await makeClient(leaver.id);
    const note = await processNoteOf(leaver.id, client.id, T0);
    expect(departure.status).toBe('executed');

    const clock = fixedClock(new Date(T0.getTime() + 29 * DAY));
    expect(await runProcessNotePurge(clock)).toEqual([]);
    expect(await prisma.processNote.count()).toBe(1);

    clock.set(new Date(T0.getTime() + 31 * DAY));
    expect(await runProcessNotePurge(clock)).toEqual([note.id]);
    expect(await prisma.processNote.count()).toBe(0);
  });

  it('takes the amendments with it, rather than leaving the text behind the row', async () => {
    const { leaver } = await departed();
    const client = await makeClient(leaver.id);
    const note = await processNoteOf(leaver.id, client.id, T0);
    await prisma.noteAmendment.create({
      data: { kind: 'process', processNoteId: note.id, authorId: leaver.id, content: 'Later thought.' },
    });

    await runProcessNotePurge(fixedClock(new Date(T0.getTime() + 31 * DAY)));
    expect(await prisma.noteAmendment.count()).toBe(0);
  });

  it('keeps amendments append-only everywhere else', async () => {
    const alex = await makeUser('therapist');
    const client = await makeClient(alex.id);
    const note = await processNoteOf(alex.id, client.id);
    const amendment = await prisma.noteAmendment.create({
      data: { kind: 'process', processNoteId: note.id, authorId: alex.id, content: 'Later thought.' },
    });

    await expect(prisma.noteAmendment.delete({ where: { id: amendment.id } })).rejects.toThrow(/append-only/);
    await expect(
      prisma.noteAmendment.update({ where: { id: amendment.id }, data: { content: 'x' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('leaves a departing clinician alone until the departure has executed', async () => {
    const { leaver } = await departed({ status: 'planned' });
    const client = await makeClient(leaver.id);
    await processNoteOf(leaver.id, client.id, T0);

    expect(await runProcessNotePurge(fixedClock(new Date(T0.getTime() + 400 * DAY)))).toEqual([]);
  });

  it('logs the destruction to the system actor, with ids and a code (P0-11)', async () => {
    const { leaver } = await departed();
    const client = await makeClient(leaver.id);
    const note = await processNoteOf(leaver.id, client.id, T0);

    await runProcessNotePurge(fixedClock(new Date(T0.getTime() + 31 * DAY)));

    const [row] = await prisma.auditEvent.findMany({ where: { resource: 'process_note' } });
    expect(row).toMatchObject({
      actorId: 'system', action: 'discard', resourceId: note.id, clientId: client.id,
      allowed: true, breakGlass: false, reason: 'departure:process_note_destroyed',
    });
    // No content, ever — not in the log that outlives the note it describes.
    expect(JSON.stringify(row)).not.toContain('Private working thinking');
  });
});

// ───────────────────────── the transaction (Phase 3) ─────────────────────────

const LAST_DAY = '2026-09-30';
const NOTICE = fixedClock('2026-09-01T13:00:00Z');
const EXECUTION = fixedClock('2026-09-30T22:00:00Z');

/** Telehealth, so no room is involved and only the clinician can clash. */
async function book(clientId: string, clinicianId: string, startIso: string, status: 'scheduled' | 'completed' = 'scheduled') {
  const startAt = new Date(startIso);
  return prisma.appointment.create({
    data: {
      clientId, clinicianId, startAt, endAt: new Date(startAt.getTime() + 50 * 60_000),
      type: 'standard', modality: 'telehealth', status,
    },
  });
}

/**
 * Alex is leaving. Kept moves to Beth; Ended is discharged. Both have a
 * session before the last day and one after it, and Kept has a standing series.
 */
async function practice(opts: { leaverRole?: 'therapist' | 'supervisor'; supervised?: boolean } = {}) {
  await resetDb();
  await settings();
  const manager = await makeUser('admin');
  const sup = await makeUser('supervisor');
  const alex = await makeUser(opts.leaverRole ?? 'therapist', {
    name: 'Alex', supervisorId: opts.supervised === false ? undefined : sup.id,
  });
  const beth = await makeUser('therapist', { name: 'Beth' });
  const kept = await makeClient(alex.id);
  const ended = await makeClient(alex.id);

  const departure = await planDeparture(actor(manager), { userId: alex.id, lastDayOn: LAST_DAY }, NOTICE);
  const decide = (clientId: string, disposition: 'transfer' | 'discharge' | 'referred_out', receivingClinicianId?: string) =>
    prisma.departureAssignment.create({
      data: { departureId: departure.id, clientId, disposition, receivingClinicianId: receivingClinicianId ?? null, decidedById: manager.id },
    });

  return { manager, sup, alex, beth, kept, ended, departure, decide };
}

/** Everything a departure writes to the log, in order. */
const departureRows = (departureId: string) =>
  prisma.auditEvent.findMany({ where: { resource: 'departure', resourceId: departureId }, orderBy: { at: 'asc' } });

describe('the record follows the client (D-04, carried over from Phase 1)', () => {
  beforeEach(async () => {
    await resetDb();
    await settings();
  });

  it('lets the clinician who carries the client read what somebody else wrote, one note and the list', async () => {
    const alex = await makeUser('therapist');
    const beth = await makeUser('therapist');
    const carl = await makeUser('therapist');
    const client = await makeClient(alex.id);
    const appt = await book(client.id, alex.id, '2026-09-10T14:00:00Z', 'completed');
    const written = await prisma.progressNote.create({
      data: { appointmentId: appt.id, clientId: client.id, authorId: alex.id, content: 'Alex wrote this.' },
    });
    const privateNote = await processNoteOf(alex.id, client.id);
    await prisma.client.update({ where: { id: client.id }, data: { treatingClinicianId: beth.id } });

    await expect(getProgressNote(actor(beth), written.id)).resolves.toMatchObject({ id: written.id });
    expect((await listProgressNotes(actor(beth), client.id)).map((n) => n.id)).toEqual([written.id]);

    // Neither wrote it, supervises its author, nor carries the client.
    await expect(getProgressNote(actor(carl), written.id)).rejects.toThrow(Forbidden);
    expect(await listProgressNotes(actor(carl), client.id)).toEqual([]);

    // One event, two opposite answers: the private note does not follow.
    await expect(getProcessNote(actor(beth), privateNote.id)).rejects.toThrow(Forbidden);
  });
});

describe('notice closes the books; withdrawal reopens only what notice closed (P0-9)', () => {
  it('closes the books on notice, and deactivates nobody', async () => {
    const { alex, departure } = await practice();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: alex.id } });
    expect(after).toMatchObject({ acceptingNewClients: false, active: true });
    expect(departure).toMatchObject({ status: 'planned', noticeAt: NOTICE.now(), acceptingNewClientsAtNotice: true });
  });

  it('restores the value at notice — a clinician who had closed their own books stays closed', async () => {
    await resetDb();
    await settings();
    const manager = await makeUser('admin');
    const alex = await makeUser('therapist');
    await prisma.user.update({ where: { id: alex.id }, data: { acceptingNewClients: false } });

    const d = await planDeparture(actor(manager), { userId: alex.id, lastDayOn: LAST_DAY }, NOTICE);
    await cancelDeparture(actor(manager), d.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alex.id } })).acceptingNewClients).toBe(false);
  });

  it('reopens an open clinician, and leaves a second notice possible', async () => {
    const { manager, alex, departure } = await practice();
    await cancelDeparture(actor(manager), departure.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alex.id } })).acceptingNewClients).toBe(true);
    await expect(planDeparture(actor(manager), { userId: alex.id, lastDayOn: '2026-12-31' }, NOTICE)).resolves.toBeTruthy();
  });

  it('refuses notice from a supervisor and from front desk, on the record', async () => {
    const { sup, alex } = await practice();
    const desk = await makeUser('front_desk');
    for (const who of [sup, desk]) {
      await expect(planDeparture(actor(who), { userId: alex.id, lastDayOn: LAST_DAY }, NOTICE)).rejects.toThrow(Forbidden);
    }
    expect(await prisma.auditEvent.count({ where: { resource: 'departure', action: 'create', allowed: false } })).toBe(2);
  });
});

describe('the transfer, in one transaction (P0-6)', () => {
  it('moves the whole caseload in one act, and leaves the past where it happened', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    const before = await book(kept.id, alex.id, '2026-09-29T14:00:00Z', 'completed');
    const keptNext = await book(kept.id, alex.id, '2026-10-06T14:00:00Z');
    const endedNext = await book(ended.id, alex.id, '2026-10-07T14:00:00Z');
    const series = await prisma.appointmentSeries.create({
      data: { clientId: kept.id, clinicianId: alex.id, weekday: 2, startMinute: 600, startDate: new Date('2026-09-01'), modality: 'telehealth' },
    });
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    await executeDeparture(actor(manager), departure.id, EXECUTION);

    expect((await prisma.client.findUniqueOrThrow({ where: { id: kept.id } })).treatingClinicianId).toBe(beth.id);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: keptNext.id } })).clinicianId).toBe(beth.id);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: before.id } })).clinicianId).toBe(alex.id);
    expect((await prisma.appointmentSeries.findUniqueOrThrow({ where: { id: series.id } })).clinicianId).toBe(beth.id);

    expect((await prisma.client.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe('inactive');
    expect(await prisma.appointment.findUniqueOrThrow({ where: { id: endedNext.id } })).toMatchObject({
      status: 'cancelled', cancelReason: 'clinician departed', cancelledById: manager.id,
    });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: alex.id } })).active).toBe(false);
    expect(await prisma.departure.findUniqueOrThrow({ where: { id: departure.id } })).toMatchObject({
      status: 'executed', executedAt: EXECUTION.now(),
    });
  });

  it('refuses a client nobody decided, and a transfer to somebody no longer here — before any write', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    await decide(kept.id, 'transfer', beth.id);
    await prisma.user.update({ where: { id: beth.id }, data: { active: false } });

    expect((await departureBlockers(actor(manager), departure.id)).map((b) => b.kind).sort())
      .toEqual(['receiver_unavailable', 'undecided']);
    await expect(executeDeparture(actor(manager), departure.id, EXECUTION)).rejects.toMatchObject({ code: 'departure_not_ready' });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: alex.id } })).active).toBe(true);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe('active');
  });

  it('shows the hour clash thirty days ahead, with the hour and both sessions', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    const moving = await book(kept.id, alex.id, '2026-10-06T14:00:00Z');
    const bethsOwn = await book(await makeClient(beth.id).then((c) => c.id), beth.id, '2026-10-06T14:30:00Z');
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    expect(await departureBlockers(actor(manager), departure.id)).toEqual([{
      kind: 'hour_clash', clientId: kept.id, appointmentId: moving.id, startAt: moving.startAt,
      receivingClinicianId: beth.id, collidesWithId: bethsOwn.id,
    }]);
  });

  it('rolls back the ENTIRE departure when Postgres refuses the hour', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    const appt = await book(kept.id, alex.id, '2026-10-06T14:00:00Z');
    await book(await makeClient(beth.id).then((c) => c.id), beth.id, '2026-10-06T14:30:00Z');
    await prisma.progressNote.create({
      data: { appointmentId: (await book(ended.id, alex.id, '2026-09-29T15:00:00Z', 'completed')).id, clientId: ended.id, authorId: alex.id, content: 'Unsigned.' },
    });
    // Discharge first, so a client row, an appointment and a series have
    // already been written when the transfer hits the constraint.
    await decide(ended.id, 'discharge');
    await decide(kept.id, 'transfer', beth.id);

    await expect(executeDeparture(actor(manager), departure.id, EXECUTION)).rejects.toMatchObject({
      name: 'Conflict', code: 'hour_clash',
    });

    // Nothing moved. Not the client written before the clash, not the account,
    // not the drafts, not the status, and not a single audit row claiming any of it.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe('active');
    expect((await prisma.client.findUniqueOrThrow({ where: { id: kept.id } })).treatingClinicianId).toBe(alex.id);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).clinicianId).toBe(alex.id);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: alex.id } })).toMatchObject({ active: true });
    expect(await prisma.progressNote.count({ where: { authorId: alex.id, status: 'draft' } })).toBe(1);
    expect((await prisma.departure.findUniqueOrThrow({ where: { id: departure.id } })).status).toBe('planned');
    expect(await prisma.auditEvent.count({ where: { action: 'depart' } })).toBe(0);
  });

  it('is the practice manager\'s act alone, and a supervisor\'s attempt is on the record', async () => {
    const { sup, kept, ended, beth, departure, decide } = await practice();
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');
    await expect(executeDeparture(actor(sup), departure.id, EXECUTION)).rejects.toThrow(Forbidden);
    expect(await prisma.auditEvent.count({ where: { action: 'depart', allowed: false, actorId: sup.id } })).toBe(1);
  });

  it('happens once', async () => {
    const { manager, kept, ended, beth, departure, decide } = await practice();
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');
    await executeDeparture(actor(manager), departure.id, EXECUTION);
    await expect(executeDeparture(actor(manager), departure.id, EXECUTION)).rejects.toMatchObject({ code: 'bad_transition' });
    await expect(cancelDeparture(actor(manager), departure.id)).rejects.toMatchObject({ code: 'bad_transition' });
  });

  it('refuses before the last day — ahead of an unready plan, before any write — and a supervisor is still refused as one (D-30)', async () => {
    const { manager, sup, alex, beth, kept, departure, decide } = await practice();
    const next = await book(kept.id, alex.id, '2026-10-06T14:00:00Z');
    await decide(kept.id, 'transfer', beth.id);
    const lastEvening = fixedClock(zonedToUtc('2026-09-29', 23 * 60 + 59));

    // Ended is still undecided. The date is what answers.
    await expect(executeDeparture(actor(manager), departure.id, lastEvening)).rejects.toMatchObject({
      name: 'Conflict', code: 'before_last_day',
    });
    await expect(executeDeparture(actor(sup), departure.id, lastEvening)).rejects.toThrow(Forbidden);

    expect(await prisma.user.findUniqueOrThrow({ where: { id: alex.id } })).toMatchObject({ active: true });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: kept.id } })).treatingClinicianId).toBe(alex.id);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: next.id } })).clinicianId).toBe(alex.id);
    expect((await prisma.departure.findUniqueOrThrow({ where: { id: departure.id } })).status).toBe('planned');
    // The supervisor's denial, and no row for the refusal the manager was given.
    expect(await prisma.auditEvent.findMany({ where: { action: 'depart' }, select: { actorId: true, allowed: true } }))
      .toEqual([{ actorId: sup.id, allowed: false }]);
  });

  it('executes from the first minute of the last day, and moves that day\'s sessions with the rest (D-30)', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    const thatMorning = await book(kept.id, alex.id, '2026-09-30T13:00:00Z');
    const later = await book(kept.id, alex.id, '2026-10-06T14:00:00Z');
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    await executeDeparture(actor(manager), departure.id, fixedClock(zonedToUtc(LAST_DAY, 0)));

    for (const a of [thatMorning, later]) {
      expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).clinicianId).toBe(beth.id);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alex.id } })).active).toBe(false);
  });
});

describe('the alert with no reader (P0-7)', () => {
  const alert = (recipientId: string, clientId: string, acknowledgedAt: Date | null = null) =>
    prisma.alert.create({ data: { recipientId, clientId, kind: 'screener_threshold', acknowledgedAt } });

  it('follows the client to its new clinician, and leaves a read alert with the person who read it', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    const unread = await alert(alex.id, kept.id);
    const read = await alert(alex.id, kept.id, new Date('2026-09-12T10:00:00Z'));
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    await executeDeparture(actor(manager), departure.id, EXECUTION);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: unread.id } })).recipientId).toBe(beth.id);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: read.id } })).recipientId).toBe(alex.id);
  });

  it('routes a discharged client\'s unread alert to the leaver\'s supervisor — one person, never an inbox', async () => {
    const { manager, sup, alex, beth, kept, ended, departure, decide } = await practice();
    const unread = await alert(alex.id, ended.id);
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'referred_out');

    await executeDeparture(actor(manager), departure.id, EXECUTION);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: unread.id } })).recipientId).toBe(sup.id);
  });

  /**
   * D-31. Alex departs and the discharged client's alert goes to Alex's
   * supervisor. When that supervisor departs in turn, the alert is about a
   * client who was never on their caseload, so the disposition loop never sees
   * it — and the supervision repoint that moves Alex has already said where it
   * belongs.
   */
  it('hands a departed supervisee\'s alert on to the supervisor who takes the supervisee', async () => {
    const { manager, sup, alex, beth, kept, ended, departure, decide } = await practice();
    const unread = await alert(alex.id, ended.id);
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');
    await executeDeparture(actor(manager), departure.id, EXECUTION);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: unread.id } })).recipientId).toBe(sup.id);

    const dana = await makeUser('supervisor', { name: 'Dana' });
    const second = await planDeparture(
      actor(manager), { userId: sup.id, lastDayOn: LAST_DAY, receivingSupervisorId: dana.id }, NOTICE,
    );
    expect(await departureBlockers(actor(manager), second.id)).toEqual([]);

    await executeDeparture(actor(manager), second.id, EXECUTION);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: unread.id } })).recipientId).toBe(dana.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alex.id } })).supervisorId).toBe(dana.id);
  });

  it('will not let the second departure close over it when nobody takes the supervisee', async () => {
    const { manager, sup, alex, beth, kept, ended, departure, decide } = await practice();
    const unread = await alert(alex.id, ended.id);
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');
    await executeDeparture(actor(manager), departure.id, EXECUTION);

    const second = await planDeparture(actor(manager), { userId: sup.id, lastDayOn: LAST_DAY }, NOTICE);
    expect(await departureBlockers(actor(manager), second.id)).toEqual(
      expect.arrayContaining([{ kind: 'unread_alert', clientId: ended.id, alertId: unread.id }]),
    );
    await expect(executeDeparture(actor(manager), second.id, EXECUTION))
      .rejects.toMatchObject({ code: 'departure_not_ready' });
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: unread.id } })).recipientId).toBe(sup.id);
  });

  it('will not close over an unread alert that has nobody to go to', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice({ supervised: false });
    const unread = await alert(alex.id, ended.id);
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    expect(await departureBlockers(actor(manager), departure.id)).toEqual([
      { kind: 'unread_alert', clientId: ended.id, alertId: unread.id },
    ]);
    await expect(executeDeparture(actor(manager), departure.id, EXECUTION)).rejects.toMatchObject({ code: 'departure_not_ready' });
  });
});

describe('the departing supervisor (P0-8)', () => {
  it('repoints the supervision tree, and the co-signature follows with no deploy', async () => {
    const { manager, alex, beth, kept, ended, decide } = await practice({ leaverRole: 'supervisor', supervised: false });
    const sam = await makeUser('supervisor');
    const ash = await makeUser('associate', { supervisorId: alex.id });
    // Alex supervises, so this plan has to name a receiver; the one from
    // `practice()` did not, and is withdrawn for a second notice that does.
    await cancelDeparture(actor(manager), (await prisma.departure.findFirstOrThrow({ where: { userId: alex.id } })).id);
    const departure = await planDeparture(
      actor(manager), { userId: alex.id, lastDayOn: LAST_DAY, receivingSupervisorId: sam.id }, NOTICE,
    );
    await prisma.departureAssignment.createMany({
      data: [
        { departureId: departure.id, clientId: kept.id, disposition: 'transfer', receivingClinicianId: beth.id, decidedById: manager.id },
        { departureId: departure.id, clientId: ended.id, disposition: 'discharge', decidedById: manager.id },
      ],
    });
    const ashClient = await makeClient(ash.id);
    const signed = await prisma.progressNote.create({
      data: {
        appointmentId: (await book(ashClient.id, ash.id, '2026-09-29T16:00:00Z', 'completed')).id,
        clientId: ashClient.id, authorId: ash.id, content: 'Signed, awaiting co-signature.',
        status: 'signed', signedAt: new Date('2026-09-29T17:00:00Z'),
      },
    });

    await executeDeparture(actor(manager), departure.id, EXECUTION);

    expect((await prisma.user.findUniqueOrThrow({ where: { id: ash.id } })).supervisorId).toBe(sam.id);
    await expect(coSignProgressNote(actor(sam), signed.id, { clock: EXECUTION })).resolves.toMatchObject({ coSignedById: sam.id });
  });

  it('refuses a departing supervisor with associates and nobody — or no supervisor — to take them', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice({ leaverRole: 'supervisor', supervised: false });
    const ash = await makeUser('associate', { supervisorId: alex.id });
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    expect(await departureBlockers(actor(manager), departure.id)).toEqual([{ kind: 'supervisee_unassigned', superviseeId: ash.id }]);

    // A therapist cannot co-sign, so naming one is the same as naming nobody.
    await prisma.departure.update({ where: { id: departure.id }, data: { receivingSupervisorId: beth.id } });
    await expect(executeDeparture(actor(manager), departure.id, EXECUTION)).rejects.toMatchObject({ code: 'departure_not_ready' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ash.id } })).supervisorId).toBe(alex.id);
  });

  it('refuses a plan that hands the supervision tree to the person leaving', async () => {
    const { alex, departure } = await practice({ leaverRole: 'supervisor' });
    await expect(
      prisma.departure.update({ where: { id: departure.id }, data: { receivingSupervisorId: alex.id } }),
    ).rejects.toThrow(/departure_supervisor_is_not_the_leaver/);
  });

  it('says in the schema that a co-signature cannot lose its signer', async () => {
    const [fk] = await prisma.$queryRaw<{ delete_rule: string }[]>`
      SELECT delete_rule FROM information_schema.referential_constraints
      WHERE constraint_name = 'ProgressNote_coSignedById_fkey'
    `;
    expect(fk?.delete_rule).toBe('RESTRICT');
  });
});

describe('what the transaction closes, and what it writes down (P0-4b, P0-10, P0-11)', () => {
  it('abandons the drafts, leaves the signed record alone, and marks the private notes unreachable', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    const noteOn = async (status: 'draft' | 'signed') => prisma.progressNote.create({
      data: {
        appointmentId: (await book(kept.id, alex.id, status === 'draft' ? '2026-09-28T14:00:00Z' : '2026-09-21T14:00:00Z', 'completed')).id,
        clientId: kept.id, authorId: alex.id, content: `A ${status} note.`, status,
        signedAt: status === 'signed' ? new Date('2026-09-21T15:00:00Z') : null,
      },
    });
    const draftNote = await noteOn('draft');
    const signedNote = await noteOn('signed');
    const alexPrivate = await processNoteOf(alex.id, kept.id);
    const bethPrivate = await processNoteOf(beth.id, kept.id);
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    await executeDeparture(actor(manager), departure.id, EXECUTION);

    expect(await prisma.progressNote.findUniqueOrThrow({ where: { id: draftNote.id } })).toMatchObject({
      status: 'abandoned', abandonedByDepartureId: departure.id, content: 'A draft note.',
    });
    expect((await prisma.progressNote.findUniqueOrThrow({ where: { id: signedNote.id } })).status).toBe('signed');
    expect((await prisma.processNote.findUniqueOrThrow({ where: { id: alexPrivate.id } })).unreachableSince).toEqual(EXECUTION.now());
    expect((await prisma.processNote.findUniqueOrThrow({ where: { id: bethPrivate.id } })).unreachableSince).toBeNull();

    // `sign` stays `author`: the clinician now carrying the client reads the
    // abandoned draft, and still cannot put her name to it.
    await expect(getProgressNote(actor(beth), draftNote.id)).resolves.toMatchObject({ status: 'abandoned' });
  });

  it('logs one row per consequence, naming the departure and the client, with codes and no content', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    await prisma.alert.create({ data: { recipientId: alex.id, clientId: kept.id, kind: 'screener_threshold' } });
    await prisma.progressNote.create({
      data: { appointmentId: (await book(kept.id, alex.id, '2026-09-28T14:00:00Z', 'completed')).id, clientId: kept.id, authorId: alex.id, content: 'Sensitive draft.' },
    });
    await processNoteOf(alex.id, ended.id);
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    await executeDeparture(actor(manager), departure.id, EXECUTION);

    const rows = await departureRows(departure.id);
    const reasons = rows.filter((r) => r.action === 'depart').map((r) => r.reason ?? '(guard)').sort();
    expect(reasons).toEqual([
      '(guard)',
      'departure:alert_repointed',
      'departure:deactivated',
      'departure:discharge',
      'departure:note_abandoned',
      'departure:process_note_unreachable',
      'departure:transfer',
    ]);
    expect(rows.find((r) => r.reason === 'departure:transfer')?.clientId).toBe(kept.id);
    expect(rows.find((r) => r.reason === 'departure:deactivated')?.clientId).toBeNull();
    expect(rows.every((r) => r.actorId === manager.id)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/Sensitive|Private working/);
  });
});

describe('the decisions, and the screens that read them (Phase 4)', () => {
  const decideAs = (who: { id: string; role: Role }, departureId: string, clientId: string,
    disposition: 'transfer' | 'discharge' | 'referred_out', receivingClinicianId?: string) =>
    decideAssignment(actor(who), departureId, { clientId, disposition, receivingClinicianId }, NOTICE);

  it('writes one decision per client, one audit row per decision, and a second decision replaces the first', async () => {
    const { manager, sup, beth, kept, departure } = await practice();
    await decideAs(sup, departure.id, kept.id, 'transfer', beth.id);
    // The receiver rides along on the form and is dropped: a discharge has nobody receiving.
    await decideAs(manager, departure.id, kept.id, 'discharge', beth.id);

    expect(await prisma.departureAssignment.findMany({ where: { departureId: departure.id } })).toMatchObject([
      { clientId: kept.id, disposition: 'discharge', receivingClinicianId: null, decidedById: manager.id },
    ]);
    expect((await departureRows(departure.id)).filter((r) => r.action === 'update').map((r) => [r.clientId, r.reason]))
      .toEqual([[kept.id, 'departure:decided_transfer'], [kept.id, 'departure:decided_discharge']]);
  });

  it('clears the blockers it answers', async () => {
    const { manager, beth, kept, ended, departure } = await practice();
    await decideAs(manager, departure.id, kept.id, 'transfer', beth.id);
    await decideAs(manager, departure.id, ended.id, 'referred_out');
    expect(await departureBlockers(actor(manager), departure.id)).toEqual([]);
  });

  it('refuses a client who is not on the caseload — execution moves whatever it is handed', async () => {
    const { manager, beth, departure } = await practice();
    const bethsOwn = await makeClient(beth.id);
    await expect(decideAs(manager, departure.id, bethsOwn.id, 'discharge')).rejects.toMatchObject({ code: 'not_on_caseload' });
    expect(await prisma.departureAssignment.count()).toBe(0);
  });

  it('refuses a transfer to nobody, to the leaver, to somebody gone, and to a role that cannot carry a client', async () => {
    const { manager, alex, beth, kept, departure } = await practice();
    const desk = await makeUser('front_desk');
    await prisma.user.update({ where: { id: beth.id }, data: { active: false } });
    for (const receiver of [undefined, alex.id, beth.id, desk.id, manager.id]) {
      await expect(decideAs(manager, departure.id, kept.id, 'transfer', receiver), String(receiver))
        .rejects.toMatchObject({ code: 'receiver_unavailable' });
    }
    expect(await prisma.departureAssignment.count()).toBe(0);
  });

  it('is front desk\'s to read and not to write, on the record — and a finished plan takes no decisions', async () => {
    const { manager, kept, departure } = await practice();
    const desk = await makeUser('front_desk');
    await expect(decideAs(desk, departure.id, kept.id, 'discharge')).rejects.toThrow(Forbidden);
    expect(await prisma.auditEvent.count({
      where: { actorId: desk.id, action: 'update', resource: 'departure', allowed: false },
    })).toBe(1);

    await cancelDeparture(actor(manager), departure.id);
    await expect(decideAs(manager, departure.id, kept.id, 'discharge')).rejects.toMatchObject({ code: 'bad_transition' });
  });

  it('does not take a client back from the clinician front desk gave them to after the decision', async () => {
    const { manager, beth, kept, ended, departure } = await practice();
    const carl = await makeUser('therapist');
    await decideAs(manager, departure.id, kept.id, 'transfer', beth.id);
    await decideAs(manager, departure.id, ended.id, 'discharge');
    await prisma.client.update({ where: { id: kept.id }, data: { treatingClinicianId: carl.id } });

    await executeDeparture(actor(manager), departure.id, EXECUTION);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: kept.id } })).treatingClinicianId).toBe(carl.id);
  });

  it('names who takes the associates, and refuses a receiver who could never co-sign', async () => {
    const { manager, alex, beth, departure } = await practice({ leaverRole: 'supervisor', supervised: false });
    await makeUser('associate', { supervisorId: alex.id });
    const sam = await makeUser('supervisor');
    const kinds = async () => (await departureBlockers(actor(manager), departure.id)).map((b) => b.kind);

    for (const wrong of [beth.id, alex.id]) {
      await expect(setReceivingSupervisor(actor(manager), departure.id, wrong)).rejects.toMatchObject({ code: 'receiver_unavailable' });
    }
    expect(await kinds()).toContain('supervisee_unassigned');
    await setReceivingSupervisor(actor(manager), departure.id, sam.id);
    expect(await kinds()).not.toContain('supervisee_unassigned');
  });

  it('answers a second notice, and a last day already gone, with a Conflict rather than a database error', async () => {
    const { manager, alex, beth } = await practice();
    await expect(planDeparture(actor(manager), { userId: alex.id, lastDayOn: '2026-10-31' }, NOTICE))
      .rejects.toMatchObject({ name: 'Conflict', code: 'already_departing' });
    await expect(planDeparture(actor(manager), { userId: beth.id, lastDayOn: '2026-08-31' }, NOTICE))
      .rejects.toMatchObject({ name: 'Conflict', code: 'last_day_past' });
  });

  it('shows the practice manager the caseload by name without breaking glass, and nothing clinical beside it', async () => {
    const { manager, alex, beth, kept, ended, departure } = await practice();
    const carl = await makeUser('therapist');
    await decideAs(manager, departure.id, kept.id, 'transfer', beth.id);

    const plan = await getDeparturePlan(actor(manager), departure.id);
    expect(plan.clients.map((c) => c.id).sort()).toEqual([kept.id, ended.id].sort());
    expect(plan.clients.find((c) => c.id === kept.id)).toMatchObject({
      assignment: { disposition: 'transfer', receivingClinician: { name: 'Beth' } },
    });
    expect(Object.keys(plan.clients[0]!).sort()).toEqual(['assignment', 'code', 'firstName', 'id', 'lastName']);
    expect(plan.blockers).toEqual([{ kind: 'undecided', clientId: ended.id }]);

    // The leaver reads their own; a colleague does not.
    await expect(getDeparturePlan(actor(alex), departure.id)).resolves.toBeTruthy();
    await expect(getDeparturePlan(actor(carl), departure.id)).rejects.toThrow(Forbidden);
  });

  it('shows the leaver their own drafts, oldest first, with the days left — and nothing to anybody staying', async () => {
    const { alex, beth, kept, ended } = await practice();
    const draft = async (clientId: string, authorId: string, iso: string) => prisma.progressNote.create({
      data: {
        appointmentId: (await book(clientId, authorId, iso, 'completed')).id,
        clientId, authorId, content: 'Unsigned.', createdAt: new Date(iso),
      },
    });
    const newer = await draft(ended.id, alex.id, '2026-09-09T14:00:00Z');
    const older = await draft(kept.id, alex.id, '2026-09-02T14:00:00Z');
    await draft((await makeClient(beth.id)).id, beth.id, '2026-09-03T14:00:00Z');

    const own = await ownDrafts(actor(alex), fixedClock('2026-09-20T15:00:00Z'));
    expect(own?.daysLeft).toBe(10);
    expect(own?.drafts.map((d) => d.id)).toEqual([older.id, newer.id]);
    expect(await ownDrafts(actor(beth))).toBeNull();
  });
});

describe('what the practice sees around a departure (Phase 5)', () => {
  const unsigned = async (clientId: string, authorId: string, iso: string) => prisma.progressNote.create({
    data: { appointmentId: (await book(clientId, authorId, iso, 'completed')).id, clientId, authorId, content: 'Unsigned.' },
  });

  it('puts every open plan on the work-list as counts, with no client in it, and asks a clinician nothing (P1-1)', async () => {
    const { alex, beth, kept, ended, departure, decide } = await practice();
    await book(kept.id, alex.id, '2026-10-06T14:00:00Z');
    await book((await makeClient(beth.id)).id, beth.id, '2026-10-06T14:30:00Z');
    await decide(kept.id, 'transfer', beth.id);
    await unsigned(ended.id, alex.id, '2026-09-15T15:00:00Z');
    const desk = await makeUser('front_desk');

    // `toEqual` on the whole row is the assertion that no client id rides along.
    expect(await departureWorklist(actor(desk), fixedClock('2026-09-20T15:00:00Z'))).toEqual([{
      id: departure.id, name: 'Alex', lastDayOn: new Date('2026-09-30T00:00:00Z'), daysLeft: 10,
      blocking: { undecided: 1, hour_clash: 1 }, unsignedNotes: 1,
    }]);
    await expect(departureWorklist(actor(beth))).rejects.toThrow(Forbidden);
  });

  it('marks a transferred record with who from, who to and when — for front desk, and only once it happened (P1-2)', async () => {
    const { manager, beth, kept, ended, departure, decide } = await practice();
    const desk = await makeUser('front_desk');
    await decide(kept.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');
    expect((await getClient(actor(desk), kept.id)).departureAssignments).toEqual([]);

    await executeDeparture(actor(manager), departure.id, EXECUTION);

    const [marker, ...rest] = (await getClient(actor(desk), kept.id)).departureAssignments;
    expect(rest).toEqual([]);
    expect(marker).toMatchObject({ receivingClinician: { name: 'Beth' }, departure: { executedAt: EXECUTION.now(), user: { name: 'Alex' } } });
    // Names and a date. No disposition, no reason, nothing else the plan decided.
    expect(Object.keys(marker!).sort()).toEqual(['departure', 'id', 'receivingClinician']);
    expect((await getClient(actor(desk), ended.id)).departureAssignments).toEqual([]);
  });

  it('tells a transferred client from which session, behind their own door — never who, never why (P1-3)', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    const spanish = await makeClient(alex.id, { language: 'es' });
    const quiet = await makeClient(alex.id);
    await prisma.client.update({ where: { id: quiet.id }, data: { reminderPreference: 'none' } });
    const unbooked = await makeClient(alex.id);
    const next = await book(kept.id, alex.id, '2026-10-06T14:00:00Z');
    await book(kept.id, alex.id, '2026-10-13T14:00:00Z');
    await book(spanish.id, alex.id, '2026-10-07T15:00:00Z');
    await book(quiet.id, alex.id, '2026-10-08T15:00:00Z');
    await book(ended.id, alex.id, '2026-10-09T15:00:00Z');
    for (const c of [kept, spanish, quiet, unbooked]) await decide(c.id, 'transfer', beth.id);
    await decide(ended.id, 'discharge');

    await executeDeparture(actor(manager), departure.id, EXECUTION);

    const sent = await prisma.outboxMessage.findMany({ where: { templateKey: 'clinician_changed' } });
    // Not the discharge — ending a relationship is a conversation — not `none`,
    // and not a client with nothing booked, who has no schedule to be told about.
    expect(sent.map((m) => m.clientId).sort()).toEqual([kept.id, spanish.id].sort());
    expect(await prisma.outboxMessage.count()).toBe(2);

    const toKept = sent.find((m) => m.clientId === kept.id)!;
    const door = await prisma.portalLink.findFirstOrThrow({ where: { clientId: kept.id } });
    expect(toKept.body).toContain(`/p/${door.token}`);
    expect(toKept.body).toContain(whenLong('en', next.startAt));
    expect(toKept.scheduledFor).toEqual(EXECUTION.now());
    expect(sent.find((m) => m.clientId === spanish.id)!.body).toMatch(/^A partir del miércoles 2026-10-07/);
    for (const m of sent) {
      expect(m.body).not.toMatch(/Beth|Alex/);
      expect(indiscreetTerms(`${m.subject} ${m.body}`)).toEqual([]);
    }
    // `none` means none: not even a door minted for a message that will never go.
    expect(await prisma.portalLink.count({ where: { clientId: quiet.id } })).toBe(0);
  });

  it('queues nothing for a departure that did not happen (P1-3)', async () => {
    const { manager, alex, beth, kept, ended, departure, decide } = await practice();
    // Decided first, so its message is already queued when the second transfer hits the constraint.
    await book(ended.id, alex.id, '2026-10-05T14:00:00Z');
    await decide(ended.id, 'transfer', beth.id);
    await book(kept.id, alex.id, '2026-10-06T14:00:00Z');
    await book((await makeClient(beth.id)).id, beth.id, '2026-10-06T14:30:00Z');
    await decide(kept.id, 'transfer', beth.id);

    await expect(executeDeparture(actor(manager), departure.id, EXECUTION)).rejects.toMatchObject({ code: 'hour_clash' });
    expect(await prisma.outboxMessage.count()).toBe(0);
    expect(await prisma.portalLink.count()).toBe(0);
  });

  it('counts the notes nobody signed, by departure, for the practice manager without breaking glass (P1-4)', async () => {
    const { manager, alex, kept, ended, departure, decide } = await practice();
    await unsigned(kept.id, alex.id, '2026-09-28T15:00:00Z');
    await unsigned(ended.id, alex.id, '2026-09-29T15:00:00Z');
    await decide(kept.id, 'discharge');
    await decide(ended.id, 'discharge');
    expect(await abandonedNotesByDeparture(actor(manager))).toEqual([]);

    await executeDeparture(actor(manager), departure.id, EXECUTION);

    expect(await abandonedNotesByDeparture(actor(manager))).toEqual([
      { id: departure.id, name: 'Alex', lastDayOn: new Date('2026-09-30T00:00:00Z'), abandoned: 2 },
    ]);
  });

  it('previews what the sweep will destroy and from when, as counts, and agrees with the sweep (P1-5)', async () => {
    await resetDb();
    await settings();
    const { leaver, manager, departure } = await departed();
    const client = await makeClient(leaver.id);
    await processNoteOf(leaver.id, client.id, T0);
    await processNoteOf(leaver.id, client.id, T0);
    const days = (await prisma.practiceSettings.findUniqueOrThrow({ where: { id: 1 } })).processNoteAfterDepartureDays;
    const due = new Date(T0.getTime() + days * DAY);
    const dayBefore = fixedClock(new Date(due.getTime() - DAY));

    // Whole-row equality: no client and no content in the preview.
    expect(await previewProcessNotePurge(actor(manager), dayBefore)).toEqual([
      { departureId: departure.id, name: leaver.name, notes: 2, dueNow: 0, destroyedFrom: due },
    ]);
    expect(await runProcessNotePurge(dayBefore)).toEqual([]);

    expect((await previewProcessNotePurge(actor(manager), fixedClock(due)))[0]).toMatchObject({ dueNow: 2 });
    expect(await runProcessNotePurge(fixedClock(due))).toHaveLength(2);
    expect(await previewProcessNotePurge(actor(manager), fixedClock(due))).toEqual([]);

    await expect(previewProcessNotePurge(actor(leaver))).rejects.toThrow(Forbidden);
  });
});
