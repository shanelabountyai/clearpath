import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, fixedClock } from '../clock';
import { prisma } from '../db';
import { Conflict } from '../errors';
import { amendProgressNote, coSignProgressNote } from '../notes/service';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import {
  TRANSITIONS, assertTransition, canTransition, runProcessNotePurge,
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
