import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { guarded } from '../auth/guard';
import { prisma } from '../db';
import { Conflict } from '../errors';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { localDateOf, zonedToUtc } from '../time';
import { availableSlots, bookAppointment, materialiseSeries, rescheduleAppointment } from './booking';
import { daySchedule } from './calendar';

const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;

let desk: Awaited<ReturnType<typeof makeUser>>;

/** Tuesdays 9:00–17:00. */
async function clinicianWorkingTuesdays() {
  const u = await makeUser('therapist');
  await prisma.availability.create({ data: { userId: u.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
  return u;
}

beforeEach(async () => {
  await resetDb();
  await settings();
  desk = await makeUser('front_desk');
});
afterAll(() => prisma.$disconnect());

describe('the conditional resource', () => {
  it('gives an in-person session a room and a telehealth session none', async () => {
    await makeRoom('Room 1');
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);

    const inPerson = await bookAppointment(actor(desk), {
      clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: 540,
      type: 'standard', modality: 'in_person',
    });
    expect(inPerson.roomId).not.toBeNull();

    const video = await bookAppointment(actor(desk), {
      clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: 660,
      type: 'standard', modality: 'telehealth', joinLink: 'https://video.example/abc',
    });
    expect(video.roomId).toBeNull();
  });

  it('with all four rooms booked at 3:00, in-person is not offered but telehealth books', async () => {
    for (const n of ['Room 1', 'Room 2', 'Room 3', 'Room 4']) await makeRoom(n);

    for (let i = 0; i < 4; i++) {
      const t = await clinicianWorkingTuesdays();
      const c = await makeClient(t.id);
      await bookAppointment(actor(desk), {
        clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: THREE_PM,
        type: 'standard', modality: 'in_person',
      });
    }

    const fifth = await clinicianWorkingTuesdays();
    const client = await makeClient(fifth.id);

    const inPerson = await availableSlots({ clinicianId: fifth.id, date: TUESDAY, type: 'standard', modality: 'in_person' });
    expect(inPerson).not.toContain(THREE_PM);

    const video = await availableSlots({ clinicianId: fifth.id, date: TUESDAY, type: 'standard', modality: 'telehealth' });
    expect(video).toContain(THREE_PM);

    const booked = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: fifth.id, date: TUESDAY, startMinute: THREE_PM,
      type: 'standard', modality: 'telehealth',
    });
    expect(booked.roomId).toBeNull();

    await expect(
      bookAppointment(actor(desk), {
        clientId: client.id, clinicianId: fifth.id, date: TUESDAY, startMinute: THREE_PM + 120,
        type: 'standard', modality: 'in_person',
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a second in-person session for the same clinician at the same hour', async () => {
    await makeRoom('Room 1'); await makeRoom('Room 2');
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);
    const base = {
      clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: THREE_PM,
      type: 'standard' as const, modality: 'in_person' as const,
    };
    await bookAppointment(actor(desk), base);
    await expect(bookAppointment(actor(desk), base)).rejects.toMatchObject({ code: 'clinician_busy' });
  });

  it('refuses telehealth that collides with the clinician, room map notwithstanding', async () => {
    await makeRoom('Room 1');
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);
    await bookAppointment(actor(desk), {
      clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: THREE_PM,
      type: 'standard', modality: 'in_person',
    });
    await expect(
      bookAppointment(actor(desk), {
        clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: THREE_PM,
        type: 'standard', modality: 'telehealth',
      }),
    ).rejects.toBeInstanceOf(Conflict);
  });
});

describe('the race for the last room', () => {
  it('lets exactly one of two simultaneous bookings win', async () => {
    await makeRoom('The only room');
    const a = await clinicianWorkingTuesdays();
    const b = await clinicianWorkingTuesdays();
    const ca = await makeClient(a.id);
    const cb = await makeClient(b.id);

    const results = await Promise.allSettled([
      bookAppointment(actor(desk), {
        clientId: ca.id, clinicianId: a.id, date: TUESDAY, startMinute: THREE_PM,
        type: 'standard', modality: 'in_person',
      }),
      bookAppointment(actor(desk), {
        clientId: cb.id, clinicianId: b.id, date: TUESDAY, startMinute: THREE_PM,
        type: 'standard', modality: 'in_person',
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.appointment.count()).toBe(1);
  });

  it('lets ten racers fill four rooms and no more', async () => {
    for (let i = 1; i <= 4; i++) await makeRoom(`Room ${i}`);
    const attempts = [];
    for (let i = 0; i < 10; i++) {
      const t = await clinicianWorkingTuesdays();
      const c = await makeClient(t.id);
      attempts.push({ t, c });
    }
    const results = await Promise.allSettled(
      attempts.map(({ t, c }) =>
        bookAppointment(actor(desk), {
          clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: THREE_PM,
          type: 'standard', modality: 'in_person',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(await prisma.appointment.count()).toBe(4);

    // The half that used to break: every loser must be told the rooms are full
    // *because they are*. A racer that walks past a room another transaction is
    // still part-way through booking reports no_room while a room stands empty.
    const reasons = results.flatMap((r) => (r.status === 'rejected' ? [r.reason.code] : []));
    expect(reasons).toEqual(Array(6).fill('no_room'));
  });
});

describe('recurring series', () => {
  const makeSeries = async () => {
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);
    const series = await prisma.appointmentSeries.create({
      data: {
        clientId: c.id, clinicianId: t.id, frequency: 'weekly', weekday: 2,
        startMinute: THREE_PM, startDate: new Date(`${TUESDAY}T12:00:00Z`),
        type: 'standard', modality: 'in_person',
      },
    });
    return { t, c, series };
  };

  it('materialises the horizon and is idempotent', async () => {
    for (let i = 1; i <= 4; i++) await makeRoom(`Room ${i}`);
    const { series } = await makeSeries();

    const first = await materialiseSeries(actor(desk), series.id, { from: TUESDAY, horizonDays: 28 });
    expect(first.created).toHaveLength(5);

    const second = await materialiseSeries(actor(desk), series.id, { from: TUESDAY, horizonDays: 28 });
    expect(second.created).toEqual([]);
    expect(second.withdrawn).toEqual([]);
    expect(await prisma.appointment.count()).toBe(5);
  });

  it('keeps a standing 3pm at 3pm across the autumn DST change', async () => {
    for (let i = 1; i <= 4; i++) await makeRoom(`Room ${i}`);
    const { series } = await makeSeries();
    await materialiseSeries(actor(desk), series.id, { from: '2026-10-27', horizonDays: 21 });

    const appts = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    const local = appts.map((a) => {
      const midnight = zonedToUtc(localDateOf(a.startAt), 0).getTime();
      return (a.startAt.getTime() - midnight) / 60_000;
    });
    expect(local).toEqual([THREE_PM, THREE_PM, THREE_PM, THREE_PM]);
    expect(appts.map((a) => localDateOf(a.startAt)))
      .toEqual(['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17']);
  });

  it('does not refill a slot a rescheduled instance moved out of', async () => {
    for (let i = 1; i <= 4; i++) await makeRoom(`Room ${i}`);
    const { series } = await makeSeries();
    await materialiseSeries(actor(desk), series.id, { from: TUESDAY, horizonDays: 21 });

    const second = await prisma.appointment.findFirstOrThrow({
      where: { startAt: { gte: zonedToUtc('2026-09-08', 0) } }, orderBy: { startAt: 'asc' },
    });
    const moved = await rescheduleAppointment(actor(desk), second.id, { date: '2026-09-10', startMinute: 600 });
    expect(moved.detached).toBe(true);

    const rerun = await materialiseSeries(actor(desk), series.id, { from: TUESDAY, horizonDays: 21 });
    expect(rerun.created).toEqual([]);
    expect(await prisma.appointment.count()).toBe(4);
  });

  it('regenerates only future instances when the pattern moves', async () => {
    for (let i = 1; i <= 4; i++) await makeRoom(`Room ${i}`);
    const { series } = await makeSeries();
    await materialiseSeries(actor(desk), series.id, { from: TUESDAY, horizonDays: 21 });

    // The client moves to Thursdays from the 15th onward.
    await prisma.appointmentSeries.update({ where: { id: series.id }, data: { weekday: 4 } });
    const run = await materialiseSeries(actor(desk), series.id, { from: '2026-09-15', horizonDays: 14 });

    const live = await prisma.appointment.findMany({
      where: { status: { not: 'cancelled' } }, orderBy: { startAt: 'asc' },
    });
    expect(live.map((a) => localDateOf(a.startAt)))
      .toEqual(['2026-09-01', '2026-09-08', '2026-09-17', '2026-09-24']);
    expect(run.withdrawn).toHaveLength(2);
  });

  it('withdraws nothing that moved on since the plan read it, and says so', async () => {
    for (let i = 1; i <= 4; i++) await makeRoom(`Room ${i}`);
    const { series } = await makeSeries();
    await materialiseSeries(actor(desk), series.id, { from: TUESDAY, horizonDays: 21 });
    await prisma.appointmentSeries.update({ where: { id: series.id }, data: { weekday: 4 } });

    // The plan reads the 15th as scheduled; the client arrives before the write.
    const read = await prisma.appointment.findMany({ where: { seriesId: series.id } });
    const fifteenth = read.find((a) => localDateOf(a.startAt) === '2026-09-15')!;
    await prisma.appointment.update({ where: { id: fifteenth.id }, data: { status: 'arrived' } });
    const real = prisma.appointment.findMany.bind(prisma.appointment);
    vi.spyOn(prisma.appointment, 'findMany').mockImplementation(real as never).mockResolvedValueOnce(read as never);

    await expect(materialiseSeries(actor(desk), series.id, { from: '2026-09-15', horizonDays: 14 }))
      .rejects.toMatchObject({ code: 'stale_status' });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: fifteenth.id } })).status).toBe('arrived');
    expect(await prisma.appointment.count({ where: { status: 'cancelled' } })).toBe(0);
  });

  it('records a week it cannot honour instead of failing the whole run', async () => {
    await makeRoom('The only room');
    const { series } = await makeSeries();

    // Somebody else has the only room on the 8th.
    const other = await clinicianWorkingTuesdays();
    const otherClient = await makeClient(other.id);
    await bookAppointment(actor(desk), {
      clientId: otherClient.id, clinicianId: other.id, date: '2026-09-08', startMinute: THREE_PM,
      type: 'standard', modality: 'in_person',
    });

    const run = await materialiseSeries(actor(desk), series.id, { from: TUESDAY, horizonDays: 14 });
    expect(run.skipped).toEqual(['2026-09-08']);
    expect(run.created).toHaveLength(2);
  });
});

describe('rescheduling', () => {
  it('moves only a session that has not started — never one that ended', async () => {
    await makeRoom('Room 1');
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);
    for (const status of ['arrived', 'in_session', 'completed', 'no_show', 'cancelled', 'late_cancelled'] as const) {
      const appt = await bookAppointment(actor(desk), {
        clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: 540,
        type: 'standard', modality: 'telehealth',
      });
      await prisma.appointment.update({ where: { id: appt.id }, data: { status } });
      await expect(rescheduleAppointment(actor(desk), appt.id, { date: '2026-09-08', startMinute: 600 }))
        .rejects.toMatchObject({ code: 'not_reschedulable' });
      const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
      expect(after.startAt).toEqual(appt.startAt);
      // Out of the hour, so the next one can book it.
      await prisma.appointment.update({ where: { id: appt.id }, data: { status: 'cancelled' } });
    }
  });

  it('refuses a session that started between the read and the write', async () => {
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);
    const appt = await bookAppointment(actor(desk), {
      clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: 540,
      type: 'standard', modality: 'telehealth',
    });
    await prisma.appointment.update({ where: { id: appt.id }, data: { status: 'arrived' } });
    const real = prisma.appointment.findUnique.bind(prisma.appointment);
    vi.spyOn(prisma.appointment, 'findUnique').mockImplementation(real as never).mockResolvedValueOnce(appt as never);

    await expect(rescheduleAppointment(actor(desk), appt.id, { date: '2026-09-08', startMinute: 600 }))
      .rejects.toMatchObject({ code: 'stale_status' });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).startAt).toEqual(appt.startAt);
  });
});

it('every booking is audit-logged against the client', async () => {
  await makeRoom('Room 1');
  const t = await clinicianWorkingTuesdays();
  const c = await makeClient(t.id);
  await bookAppointment(actor(desk), {
    clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: 540,
    type: 'standard', modality: 'in_person',
  });
  const rows = await prisma.auditEvent.findMany({ where: { clientId: c.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'create', resource: 'appointment', allowed: true });
});

describe('a DST Sunday', () => {
  // 2026-03-08 has 23 hours. A 10:00 session is 9 elapsed hours after
  // midnight; read that way it sits at 9:00, and 10:00 looks free.
  const SPRING = '2026-03-08';

  it('keeps a booked 10:00 at 10:00 in the slot finder and on the calendar', async () => {
    const t = await makeUser('therapist');
    await prisma.availability.create({ data: { userId: t.id, weekday: 0, startMinute: 540, endMinute: 1020 } });
    const c = await makeClient(t.id);
    await bookAppointment(actor(desk), {
      clientId: c.id, clinicianId: t.id, date: SPRING, startMinute: 600,
      type: 'standard', modality: 'telehealth', joinLink: 'https://video.example/dst',
    });

    const slots = await availableSlots({ clinicianId: t.id, date: SPRING, type: 'standard', modality: 'telehealth' });
    expect(slots).not.toContain(600);
    expect(slots).toContain(540);

    const [session] = (await daySchedule(actor(desk), SPRING)).sessions;
    expect(session).toMatchObject({ startMinute: 600, endMinute: 650 });
  });
});

describe('date-only columns read as the date they store', () => {
  // A `@db.Date` comes back as UTC midnight, which is the evening before in
  // New York. Read through `localDateOf` it lands a day early.
  const dayOff = (userId: string, date: string) =>
    prisma.availabilityOverride.create({
      data: { userId, fromDate: new Date(`${date}T00:00:00Z`), toDate: new Date(`${date}T00:00:00Z`), kind: 'unavailable' },
    });

  it('a one-day override blocks that day in the slot finder', async () => {
    const t = await clinicianWorkingTuesdays();
    await dayOff(t.id, TUESDAY);
    expect(await availableSlots({ clinicianId: t.id, date: TUESDAY, type: 'standard', modality: 'telehealth' })).toEqual([]);
  });

  it('a one-day override marks the clinician away on the day schedule', async () => {
    const t = await clinicianWorkingTuesdays();
    await dayOff(t.id, TUESDAY);
    expect((await daySchedule(actor(desk), TUESDAY)).away).toContain(t.id);
  });

  it('extra hours or an afternoon off do not mark the clinician away', async () => {
    const t = await clinicianWorkingTuesdays();
    const day = new Date(`${TUESDAY}T00:00:00Z`);
    await prisma.availabilityOverride.createMany({
      data: [
        { userId: t.id, fromDate: day, toDate: day, kind: 'available', startMinute: 1020, endMinute: 1140 },
        { userId: t.id, fromDate: day, toDate: day, kind: 'unavailable', startMinute: 780, endMinute: 1020 },
      ],
    });
    expect((await daySchedule(actor(desk), TUESDAY)).away).not.toContain(t.id);
  });

  it('a series ending on a Tuesday still books that Tuesday', async () => {
    for (let i = 1; i <= 4; i++) await makeRoom(`Room ${i}`);
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);
    const series = await prisma.appointmentSeries.create({
      data: {
        clientId: c.id, clinicianId: t.id, frequency: 'weekly', weekday: 2, startMinute: THREE_PM,
        startDate: new Date(`${TUESDAY}T00:00:00Z`), endDate: new Date('2026-09-15T00:00:00Z'),
        type: 'standard', modality: 'in_person',
      },
    });
    await materialiseSeries(actor(desk), series.id, { from: TUESDAY, horizonDays: 28 });
    const appts = await prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    expect(appts.map((a) => localDateOf(a.startAt))).toEqual(['2026-09-01', '2026-09-08', '2026-09-15']);
  });
});
