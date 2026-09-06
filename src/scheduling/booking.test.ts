import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import { guarded } from '../auth/guard';
import { prisma } from '../db';
import { Conflict } from '../errors';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { localDateOf, zonedToUtc } from '../time';
import { availableSlots, bookAppointment, materialiseSeries, rescheduleAppointment } from './booking';

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

/**
 * When a booking was made is not decoration: `dueStages` treats `createdAt` as
 * the notice the client had, so it decides which reminder stages were ever
 * sendable — and therefore whether silence can become a fee.
 *
 * Left to `@default(now())` the value comes from the *database* clock, which
 * the pg adapter labels in the session's timezone rather than in UTC. Write and
 * read cancel out for every column the application writes, so the app stays
 * self-consistent and every spec passes; a column Postgres fills does not go
 * through that lens. West of Greenwich it therefore reads back earlier than it
 * truly is, which *widens* stage eligibility — the wrong direction for a rule
 * with money on it, and invisible on a UTC box. So the injected clock writes it,
 * like every other instant in this application.
 */
describe('when the booking was made comes from the clock, not the database', () => {
  const BOOKED_AT = new Date('2026-08-01T14:30:00Z');

  it('stamps a single booking', async () => {
    await makeRoom('Room 1');
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);

    const appt = await bookAppointment(actor(desk), {
      clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: 540,
      type: 'standard', modality: 'in_person', clock: fixedClock(BOOKED_AT),
    });
    expect(appt.createdAt.toISOString()).toBe(BOOKED_AT.toISOString());
  });

  it('stamps every instance a series materialises', async () => {
    await makeRoom('Room 1');
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);
    const series = await prisma.appointmentSeries.create({
      data: {
        clientId: c.id, clinicianId: t.id, weekday: 2, startMinute: THREE_PM,
        frequency: 'weekly', startDate: new Date(`${TUESDAY}T12:00:00Z`),
        type: 'standard', modality: 'in_person',
      },
    });

    await materialiseSeries(actor(desk), series.id, {
      from: TUESDAY, horizonDays: 14, clock: fixedClock(BOOKED_AT),
    });

    const made = await prisma.appointment.findMany({ where: { seriesId: series.id } });
    expect(made.length).toBeGreaterThan(1);
    for (const a of made) expect(a.createdAt.toISOString()).toBe(BOOKED_AT.toISOString());
  });

  it('defaults to now when no clock is passed', async () => {
    await makeRoom('Room 1');
    const t = await clinicianWorkingTuesdays();
    const c = await makeClient(t.id);
    const appt = await bookAppointment(actor(desk), {
      clientId: c.id, clinicianId: t.id, date: TUESDAY, startMinute: 540,
      type: 'standard', modality: 'in_person',
    });
    expect(Math.abs(appt.createdAt.getTime() - Date.now())).toBeLessThan(10_000);
  });
});

/**
 * The behavioural specs above cover the two inserts that exist. This covers the
 * one written next month: an `appointment.create` that omits `createdAt` gets
 * the database's clock back, and nothing in the suite would notice until a fee
 * landed on the wrong side of a stage boundary.
 *
 * `bookedAt` is held to the same rule and for a sharper reason. It has no column
 * default at all, so an insert that omits it fails loudly — but an insert that
 * sets it to something other than the injected clock's instant fails silently,
 * in exactly the direction that widens stage eligibility. Naming it beside
 * `createdAt` at every insert is what keeps the two from drifting apart at
 * booking, which is the one moment they are required to agree.
 */
it('every appointment insert names createdAt and bookedAt', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(/\bappointment\.create(?:Many)?\b/g)) {
        const args = callArgs(src, (m.index ?? 0) + m[0].length);
        for (const field of ['createdAt', 'bookedAt']) {
          if (!args.includes(field)) offenders.push(`${path}: ${m[0]} omits ${field}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

/**
 * And the other half of the same rule, which is about the *update* nobody has
 * written yet.
 *
 * A reschedule moves the hour, and the confirmation loop's entire notion of
 * "we asked" is anchored to when the hour was set. A second path that writes
 * `startAt` without `bookedAt` — a drag-and-drop calendar, a bulk shift for a
 * clinician's changed availability, a script that nudges a day's sessions by
 * fifteen minutes — would leave every one of those appointments carrying
 * delivered reminders about a time that no longer exists, and the sweep would
 * charge for silence about a withdrawn question. Every behavioural spec in this
 * file would still pass, because none of them calls it.
 */
it('every appointment update that moves the hour restamps bookedAt', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(/\bappointment\.update(?:Many)?\b/g)) {
        const args = callArgs(src, (m.index ?? 0) + m[0].length);
        // `startAt` inside a `where` is a filter, not a move. `assertsLiteral`
        // does this properly for enum writes; here the field is a variable, so
        // the cheaper test is whether the data block names it at all.
        if (!writesField(args, 'startAt')) continue;
        if (!args.includes('bookedAt')) offenders.push(`${path}: ${m[0]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

/** Whether `field` is written by the `data:` block of a Prisma call's args. */
function writesField(args: string, field: string): boolean {
  const at = args.indexOf('data:');
  if (at === -1) return false;
  let depth = 0;
  for (let i = args.indexOf('{', at); i < args.length && i !== -1; i++) {
    if (args[i] === '{') depth++;
    else if (args[i] === '}' && --depth === 0) {
      return new RegExp(`\\b${field}\\b`).test(args.slice(at, i + 1));
    }
  }
  return false;
}

/** The argument text of the call starting at `from`, parens balanced. */
function callArgs(src: string, from: number): string {
  const open = src.indexOf('(', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}
