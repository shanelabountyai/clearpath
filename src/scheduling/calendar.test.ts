import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Forbidden, NotFound } from '../errors';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { zonedToUtc } from '../time';
import { daySchedule, getAppointment } from './calendar';

/**
 * The day view had no tests of its own until this file.
 *
 * It was covered from above by the e2e suite, which walks the page and finds
 * the chips it expects — and every bug in here was invisible to that, because
 * the page renders exactly what this module hands it. The absence banner was
 * wrong six days a week and the pictures still looked right.
 */

const TUESDAY = '2026-09-01';
const WEDNESDAY = '2026-09-02';
const NINE_AM = 9 * 60;

let desk: Awaited<ReturnType<typeof makeUser>>;
let clinician: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;
let auditorUser: Awaited<ReturnType<typeof makeUser>>;

/** Tuesdays 9:00–17:00, for both clinicians. */
async function worksTuesdays(userId: string) {
  await prisma.availability.create({
    data: { userId, weekday: 2, startMinute: 540, endMinute: 1020 },
  });
}

beforeEach(async () => {
  await resetDb();
  await settings();
  desk = await makeUser('front_desk');
  clinician = await makeUser('therapist', { name: 'Ada Ling' });
  other = await makeUser('therapist', { name: 'Bo Ferreira' });
  auditorUser = await makeUser('auditor');
  await worksTuesdays(clinician.id);
  await worksTuesdays(other.id);
});
afterAll(() => prisma.$disconnect());

async function session(opts: {
  clinicianId: string;
  startMinute: number;
  date?: string;
  roomId?: string;
  durationMinutes?: number;
}) {
  const date = opts.date ?? TUESDAY;
  const client = await makeClient(opts.clinicianId);
  return prisma.appointment.create({
    data: {
      clientId: client.id,
      clinicianId: opts.clinicianId,
      roomId: opts.roomId ?? null,
      modality: opts.roomId ? 'in_person' : 'telehealth',
      startAt: zonedToUtc(date, opts.startMinute),
      endAt: zonedToUtc(date, opts.startMinute + (opts.durationMinutes ?? 50)),
    },
  });
}

/** A `date` column holds a calendar date; Postgres returns it as UTC midnight. */
const dateColumn = (d: string) => new Date(`${d}T00:00:00Z`);

async function absence(opts: {
  userId?: string;
  from?: string;
  to?: string;
  startMinute?: number;
  endMinute?: number;
  reason?: string;
  kind?: 'unavailable' | 'available';
}) {
  return prisma.availabilityOverride.create({
    data: {
      userId: opts.userId ?? clinician.id,
      kind: opts.kind ?? 'unavailable',
      fromDate: dateColumn(opts.from ?? TUESDAY),
      toDate: dateColumn(opts.to ?? opts.from ?? TUESDAY),
      startMinute: opts.startMinute ?? null,
      endMinute: opts.endMinute ?? null,
      reason: opts.reason ?? null,
    },
  });
}

describe('the day, as front desk reads it', () => {
  it('places each session by minutes from local midnight', async () => {
    const room = await makeRoom('Room 1');
    await session({ clinicianId: clinician.id, startMinute: NINE_AM, roomId: room.id });

    const day = await daySchedule(actor(desk), TUESDAY);

    expect(day.sessions).toHaveLength(1);
    expect(day.sessions[0]).toMatchObject({ startMinute: 540, endMinute: 590 });
  });

  it('measures from local midnight, not UTC midnight', async () => {
    // A summer Tuesday is UTC-4 here. Measuring from the wrong midnight would
    // put a 9:00 session at 13:00 and slide the whole grid four hours.
    const room = await makeRoom('Room 1');
    await session({ clinicianId: clinician.id, startMinute: NINE_AM, roomId: room.id, date: '2026-01-13' });

    const winter = await daySchedule(actor(desk), '2026-01-13');
    expect(winter.sessions[0]?.startMinute).toBe(540);
  });

  it('holds one day and excludes the days either side', async () => {
    const room = await makeRoom('Room 1');
    await session({ clinicianId: clinician.id, startMinute: 23 * 60, roomId: room.id, date: '2026-08-31', durationMinutes: 30 });
    await session({ clinicianId: clinician.id, startMinute: 0, roomId: room.id, date: WEDNESDAY, durationMinutes: 30 });
    await session({ clinicianId: clinician.id, startMinute: NINE_AM, roomId: room.id });

    const day = await daySchedule(actor(desk), TUESDAY);
    expect(day.sessions).toHaveLength(1);
    expect(day.sessions[0]?.startMinute).toBe(540);
  });

  it('breaks a tie by id, so two reads of one day agree', async () => {
    const [a, b] = [await makeRoom('Room 1'), await makeRoom('Room 2')];
    await session({ clinicianId: clinician.id, startMinute: 10 * 60, roomId: a.id });
    await session({ clinicianId: other.id, startMinute: 10 * 60, roomId: b.id });

    const first = await daySchedule(actor(desk), TUESDAY);
    const second = await daySchedule(actor(desk), TUESDAY);

    expect(first.sessions.map((s) => s.id)).toEqual(second.sessions.map((s) => s.id));
    expect(first.sessions.map((s) => s.id)).toEqual([...first.sessions.map((s) => s.id)].sort());
  });

  it('shows front desk the whole practice', async () => {
    const [a, b] = [await makeRoom('Room 1'), await makeRoom('Room 2')];
    await session({ clinicianId: clinician.id, startMinute: 10 * 60, roomId: a.id });
    await session({ clinicianId: other.id, startMinute: 11 * 60, roomId: b.id });

    const day = await daySchedule(actor(desk), TUESDAY);
    expect(day.sessions).toHaveLength(2);
    expect(day.clinicians.map((c) => c.name)).toEqual(['Ada Ling', 'Bo Ferreira']);
  });

  it('shows a clinician their own caseload and nobody else', async () => {
    const [a, b] = [await makeRoom('Room 1'), await makeRoom('Room 2')];
    await session({ clinicianId: clinician.id, startMinute: 10 * 60, roomId: a.id });
    await session({ clinicianId: other.id, startMinute: 11 * 60, roomId: b.id });

    const day = await daySchedule(actor(clinician), TUESDAY);
    expect(day.sessions.map((s) => s.clinicianId)).toEqual([clinician.id]);
    expect(day.clinicians.map((c) => c.id)).toEqual([clinician.id]);
  });

  it('logs the read once, with no client on the row', async () => {
    await daySchedule(actor(desk), TUESDAY);

    const rows = await prisma.auditEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: desk.id, action: 'read', resource: 'appointment', allowed: true, clientId: null,
    });
  });

  it('refuses the auditor and logs the denial', async () => {
    await expect(daySchedule(actor(auditorUser), TUESDAY)).rejects.toBeInstanceOf(Forbidden);

    const rows = await prisma.auditEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: auditorUser.id, resource: 'appointment', allowed: false });
  });
});

describe('who is out, and for how much of the day', () => {
  it('does not call two hours at the dentist a day off', async () => {
    // The regression. The old computation subtracted every override from a
    // synthetic window pinned to weekday 0, so on the six days that are not
    // Sunday any override at all emptied the day and read as away — while the
    // clinician's morning and afternoon sat in the grid underneath the banner.
    await absence({ startMinute: 780, endMinute: 900, reason: 'Dentist' });

    const day = await daySchedule(actor(desk), TUESDAY);

    expect(day.absences).toEqual([
      { userId: clinician.id, reason: 'Dentist', allDay: false, lost: [{ startMinute: 780, endMinute: 900 }] },
    ]);
  });

  it('calls a day off a day off', async () => {
    await absence({ reason: 'Annual leave' });

    const day = await daySchedule(actor(desk), TUESDAY);

    expect(day.absences).toEqual([
      { userId: clinician.id, reason: 'Annual leave', allDay: true, lost: [{ startMinute: 540, endMinute: 1020 }] },
    ]);
  });

  it('reads the range as the calendar dates the column holds', async () => {
    // A `date` column comes back as UTC midnight, and reading it as an instant
    // in a timezone behind UTC moved every absence a day early — so a vacation
    // was applied to the day before it started and stopped a day short.
    await absence({ from: TUESDAY, to: TUESDAY, reason: 'Annual leave' });

    expect((await daySchedule(actor(desk), '2026-08-31')).absences).toEqual([]);
    expect((await daySchedule(actor(desk), TUESDAY)).absences).toHaveLength(1);
  });

  it('covers the last day of a range as well as the first', async () => {
    await absence({ from: '2026-08-31', to: TUESDAY, reason: 'Annual leave' });

    expect((await daySchedule(actor(desk), TUESDAY)).absences).toHaveLength(1);
    expect((await daySchedule(actor(desk), WEDNESDAY)).absences).toEqual([]);
  });

  it('says nothing about a weekday the clinician does not work', async () => {
    // Nobody works Wednesdays here. A vacation that covers one takes no
    // working time away, and a banner announcing it is noise in a warning.
    await absence({ from: TUESDAY, to: WEDNESDAY, reason: 'Annual leave' });

    expect((await daySchedule(actor(desk), WEDNESDAY)).absences).toEqual([]);
    expect((await daySchedule(actor(desk), TUESDAY)).absences).toHaveLength(1);
  });

  it('says nothing when an override only adds hours', async () => {
    await absence({ kind: 'available', from: WEDNESDAY, startMinute: 600, endMinute: 720, reason: 'Extra shift' });

    expect((await daySchedule(actor(desk), WEDNESDAY)).absences).toEqual([]);
  });

  it('reports two blocks in one day as two windows, under both reasons', async () => {
    await absence({ startMinute: 600, endMinute: 660, reason: 'Dentist' });
    await absence({ startMinute: 840, endMinute: 900, reason: 'School run' });

    const [out] = (await daySchedule(actor(desk), TUESDAY)).absences;
    expect(out?.lost).toEqual([
      { startMinute: 600, endMinute: 660 },
      { startMinute: 840, endMinute: 900 },
    ]);
    expect(out?.reason).toBe('Dentist; School run');
  });

  it('falls back to a reason when the override carries none', async () => {
    await absence({});
    const [out] = (await daySchedule(actor(desk), TUESDAY)).absences;
    expect(out?.reason).toBe('Unavailable');
  });

  it('does not report a colleague to a clinician reading their own day', async () => {
    // The overrides used to be fetched for the whole practice, so this said
    // "A clinician (Annual leave)" — an absence and its reason attached to a
    // name the reader was not shown.
    await absence({ userId: other.id, reason: 'Annual leave' });

    expect((await daySchedule(actor(clinician), TUESDAY)).absences).toEqual([]);
    expect((await daySchedule(actor(desk), TUESDAY)).absences).toHaveLength(1);
  });

  it('ignores an override belonging to somebody with no caseload', async () => {
    const admin = await makeUser('admin');
    await absence({ userId: admin.id, reason: 'Conference' });

    expect((await daySchedule(actor(desk), TUESDAY)).absences).toEqual([]);
  });
});

describe('one session in full', () => {
  it('returns the record with the people and the room on it', async () => {
    const room = await makeRoom('Room 1');
    const appt = await session({ clinicianId: clinician.id, startMinute: NINE_AM, roomId: room.id });

    const full = await getAppointment(actor(desk), appt.id);

    expect(full).toMatchObject({ id: appt.id, room: { name: 'Room 1' }, clinician: { name: 'Ada Ling' } });
    expect(full.client.code).toMatch(/^TC-/);
  });

  it('is a not-found for an id that does not exist, not a crash', async () => {
    await expect(getAppointment(actor(desk), 'nope')).rejects.toBeInstanceOf(NotFound);
  });

  it('refuses the auditor and logs the denial against the client', async () => {
    const room = await makeRoom('Room 1');
    const appt = await session({ clinicianId: clinician.id, startMinute: NINE_AM, roomId: room.id });

    await expect(getAppointment(actor(auditorUser), appt.id)).rejects.toBeInstanceOf(Forbidden);

    const rows = await prisma.auditEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: auditorUser.id, resource: 'appointment', resourceId: appt.id,
      clientId: appt.clientId, allowed: false,
    });
  });

  it('names the appointment and its client on the granted read', async () => {
    const room = await makeRoom('Room 1');
    const appt = await session({ clinicianId: clinician.id, startMinute: NINE_AM, roomId: room.id });

    await getAppointment(actor(desk), appt.id);

    const rows = await prisma.auditEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceId: appt.id, clientId: appt.clientId, allowed: true });
  });
});
