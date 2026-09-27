import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { openInboundReplies } from '../messaging/inbound';
import { createProgressNote } from '../notes/service';
import { openRescheduleRequests } from '../portal/service';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { zonedToUtc } from '../time';
import { bookAppointment, createSeries, rescheduleAppointment } from './booking';
import { getAppointment } from './calendar';
import { bookGroupSession, getGroupSession } from './groups';
import { cancelAppointment, setStatus } from './lifecycle';
import { unconfirmedSoon, vacationImpact } from './worklists';

/**
 * K4-C1 (SEC-07..SEC-10): a clinician reaches the sessions booked with them and
 * their caseload's, and books only their caseload. Therapist A never treats
 * B's client here; every refusal below was an `always` before.
 */
const TUESDAY = '2026-09-01';

let desk: Awaited<ReturnType<typeof makeUser>>;
let a: Awaited<ReturnType<typeof makeUser>>;
let b: Awaited<ReturnType<typeof makeUser>>;
let bsClient: Awaited<ReturnType<typeof makeClient>>;

beforeEach(async () => {
  await resetDb();
  await settings();
  await makeRoom('Room 1');
  desk = await makeUser('front_desk');
  a = await makeUser('therapist');
  b = await makeUser('therapist');
  for (const u of [a, b]) {
    await prisma.availability.create({ data: { userId: u.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
  }
  bsClient = await makeClient(b.id);
});
afterAll(() => prisma.$disconnect());

const oneOff = (by: typeof a, clinicianId: string, startMinute = 600) =>
  bookAppointment(actor(by), {
    clientId: bsClient.id, clinicianId, date: TUESDAY, startMinute, type: 'standard', modality: 'in_person',
  });

describe('booking is caseload-only for clinicians (SEC-07)', () => {
  it("refuses therapist A booking B's client with themselves, and logs the denial", async () => {
    await expect(oneOff(a, a.id)).rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.appointment.count()).toBe(0);
    expect(await prisma.auditEvent.count({
      where: { actorId: a.id, action: 'create', resource: 'appointment', allowed: false, clientId: bsClient.id },
    })).toBe(1);
  });

  it('refuses a standing series and a group the same way', async () => {
    await expect(createSeries(actor(a), {
      clientId: bsClient.id, clinicianId: a.id, type: 'standard', modality: 'in_person',
      frequency: 'weekly', weekday: 2, startMinute: 600, startDate: zonedToUtc(TUESDAY, 12 * 60),
    })).rejects.toBeInstanceOf(Forbidden);
    await expect(bookGroupSession(actor(a), {
      clinicianId: a.id, clientIds: [bsClient.id], date: TUESDAY, startMinute: 600,
    })).rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.appointmentSeries.count()).toBe(0);
    expect(await prisma.appointment.count()).toBe(0);
  });

  it('still lets the treating clinician and front desk book, desk for anyone with anyone', async () => {
    await expect(oneOff(b, b.id)).resolves.toBeTruthy();
    await expect(oneOff(desk, a.id, 720)).resolves.toBeTruthy();
  });
});

describe("a progress note is decided on the client, not the session's clinician (SEC-07)", () => {
  it("refuses therapist A a note on B's client even on a session booked with A", async () => {
    const appt = await oneOff(desk, a.id);
    await expect(createProgressNote(actor(a), { appointmentId: appt.id, content: 'x' }))
      .rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.progressNote.count()).toBe(0);
    await expect(createProgressNote(actor(b), { appointmentId: appt.id, content: 'x' })).resolves.toBeTruthy();
  });
});

describe('a group leader writes up the session they led, for its attendees only (D-32)', () => {
  const rowOf = (groupSessionId: string, clientId: string) =>
    prisma.appointment.findFirstOrThrow({ where: { groupSessionId, clientId } });

  it("lets A start the note for B's client on a group A leads", async () => {
    const group = await bookGroupSession(actor(desk), {
      clinicianId: a.id, clientIds: [bsClient.id], date: TUESDAY, startMinute: 600,
    });
    const row = await rowOf(group.id, bsClient.id);
    await expect(createProgressNote(actor(a), { appointmentId: row.id, content: 'x' }))
      .resolves.toMatchObject({ appointmentId: row.id, clientId: bsClient.id, authorId: a.id });
  });

  it("refuses A a note for an attendee of somebody else's group", async () => {
    await bookGroupSession(actor(desk), { clinicianId: a.id, clientIds: [bsClient.id], date: TUESDAY, startMinute: 600 });
    const c = await makeUser('therapist');
    const csClient = await makeClient(c.id);
    const other = await bookGroupSession(actor(desk), {
      clinicianId: c.id, clientIds: [csClient.id], date: TUESDAY, startMinute: 720,
    });
    const row = await rowOf(other.id, csClient.id);
    await expect(createProgressNote(actor(a), { appointmentId: row.id, content: 'x' }))
      .rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.progressNote.count()).toBe(0);
  });

  it('refuses a supervisor booking a supervisee\'s client into a group they lead; the treating clinician may', async () => {
    const sup = await makeUser('supervisor');
    const sv = await makeUser('therapist', { supervisorId: sup.id });
    const svClient = await makeClient(sv.id);
    await expect(bookGroupSession(actor(sup), {
      clinicianId: sup.id, clientIds: [svClient.id], date: TUESDAY, startMinute: 600,
    })).rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.appointment.count()).toBe(0);
    // B hands their own client to A's group: B's call, and it grants A that session.
    await expect(bookGroupSession(actor(b), {
      clinicianId: a.id, clientIds: [bsClient.id], date: TUESDAY, startMinute: 720,
    })).resolves.toMatchObject({ id: expect.any(String) });
    expect(await prisma.appointment.count({ where: { clientId: bsClient.id, clinicianId: a.id } })).toBe(1);
  });
});

describe('a session by id: its clinician and the caseload only (SEC-08)', () => {
  it("refuses an unrelated therapist reading, moving, marking or cancelling B's session", async () => {
    const appt = await oneOff(desk, b.id);
    const c = await makeUser('therapist');
    await expect(getAppointment(actor(c), appt.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(setStatus(actor(c), appt.id, 'arrived')).rejects.toBeInstanceOf(Forbidden);
    await expect(cancelAppointment(actor(c), appt.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(rescheduleAppointment(actor(c), appt.id, { date: TUESDAY, startMinute: 780 }))
      .rejects.toBeInstanceOf(Forbidden);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe('scheduled');
  });

  it('allows the treating clinician, and the clinician the session is booked with', async () => {
    const appt = await oneOff(desk, a.id);
    await expect(getAppointment(actor(b), appt.id)).resolves.toBeTruthy();
    await expect(getAppointment(actor(a), appt.id)).resolves.toBeTruthy();
  });
});

describe('a group roster is a guarded, audited read (SEC-09)', () => {
  it('refuses the auditor and a stranger with a denial on the record, and lets the facilitator in', async () => {
    const group = await bookGroupSession(actor(desk), {
      clinicianId: a.id, clientIds: [bsClient.id], date: TUESDAY, startMinute: 600,
    });
    const auditor = await makeUser('auditor');
    const c = await makeUser('therapist');
    await expect(getGroupSession(actor(auditor), group.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(getGroupSession(actor(c), group.id)).rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.auditEvent.count({ where: { actorId: auditor.id, resource: 'appointment', allowed: false } })).toBe(1);
    await expect(getGroupSession(actor(a), group.id)).resolves.toMatchObject({ id: group.id });
    expect(await prisma.auditEvent.count({ where: { actorId: a.id, action: 'read', allowed: true } })).toBe(1);
  });
});

describe("the practice's work lists are front desk's (SEC-10)", () => {
  it('refuses a clinician every whole-practice list, and serves front desk', async () => {
    const window = { clinicianId: b.id, fromDate: TUESDAY, toDate: TUESDAY };
    for (const read of [
      () => unconfirmedSoon(actor(a)),
      () => vacationImpact(actor(a), window),
      () => openInboundReplies(actor(a)),
      () => openRescheduleRequests(actor(a)),
    ]) await expect(read()).rejects.toBeInstanceOf(Forbidden);

    await expect(unconfirmedSoon(actor(desk))).resolves.toEqual([]);
    await expect(vacationImpact(actor(desk), window)).resolves.toEqual([]);
  });
});
