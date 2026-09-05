import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { guarded } from '../auth/guard';
import { fixedClock, DAY, HOUR } from '../clock';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { bookAppointment } from '../scheduling/booking';
import { cancelAppointment, setStatus } from '../scheduling/lifecycle';
import { continuityQueue, vacationImpact, waitlistMatches } from '../scheduling/worklists';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { queryAuditLog, toCsv } from './audit';
import { utilizationReport, weeklyVolume, weekStart } from './utilization';

let desk: Awaited<ReturnType<typeof makeUser>>;
let therapist: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let auditorUser: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await resetDb();
  await settings({ continuityGapDays: 21 });
  desk = await makeUser('front_desk');
  therapist = await makeUser('therapist');
  admin = await makeUser('admin');
  auditorUser = await makeUser('auditor');
  await prisma.availability.create({ data: { userId: therapist.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
  for (let i = 1; i <= 4; i++) await makeRoom(`Room ${i}`);
});
afterAll(() => prisma.$disconnect());

const book = (clientId: string, startMinute: number, date = '2026-09-01') =>
  bookAppointment(actor(desk), {
    clientId, clinicianId: therapist.id, date, startMinute, type: 'standard', modality: 'in_person',
  });

describe('the vacation work-list', () => {
  it('surfaces every standing client an absence displaces', async () => {
    const a = await makeClient(therapist.id);
    const b = await makeClient(therapist.id);
    const series = await prisma.appointmentSeries.create({
      data: {
        clientId: a.id, clinicianId: therapist.id, weekday: 2, startMinute: 900,
        startDate: new Date('2026-09-01T12:00:00Z'), type: 'standard', modality: 'in_person',
      },
    });
    const standing = await book(a.id, 900);
    await prisma.appointment.update({ where: { id: standing.id }, data: { seriesId: series.id } });
    await book(b.id, 1020);

    const impact = await vacationImpact(actor(desk), {
      clinicianId: therapist.id, fromDate: '2026-09-01', toDate: '2026-09-05',
    });
    expect(impact).toHaveLength(2);
    expect(impact[0]!.standing).toBe(true);
    expect(impact[1]!.standing).toBe(false);
    expect(impact.map((i) => i.date)).toEqual(['2026-09-01', '2026-09-01']);
  });

  it('narrows to the hours of a part-day absence', async () => {
    // Two hours at the dentist is not a day off. The list used to hand back
    // every session in the range, so a work-list whose entire value is that
    // each row needs a phone call filled up with clients nobody had to ring.
    const morning = await makeClient(therapist.id, { code: 'TC-MORNING' });
    const afternoon = await makeClient(therapist.id, { code: 'TC-AFTERNOON' });
    await book(morning.id, 600); // 10:00
    await book(afternoon.id, 840); // 14:00

    const impact = await vacationImpact(actor(desk), {
      clinicianId: therapist.id, fromDate: '2026-09-01', toDate: '2026-09-01',
      startMinute: 780, endMinute: 900, // out 13:00–15:00
    });
    expect(impact.map((i) => i.client.code)).toEqual(['TC-AFTERNOON']);
  });

  it('counts a session that only overlaps the edge of the absence', async () => {
    // Out from 13:00: the 12:30 session runs to 13:20 and is displaced; the
    // one that ends exactly at 13:00 is not, because the window is half-open.
    const straddles = await makeClient(therapist.id, { code: 'TC-STRADDLES' });
    const clears = await makeClient(therapist.id, { code: 'TC-CLEARS' });
    await book(straddles.id, 750); // 12:30–13:20
    await book(clears.id, 670); // 11:10–12:00

    const impact = await vacationImpact(actor(desk), {
      clinicianId: therapist.id, fromDate: '2026-09-01', toDate: '2026-09-01',
      startMinute: 780, endMinute: 1020,
    });
    expect(impact.map((i) => i.client.code)).toEqual(['TC-STRADDLES']);

    const touching = await vacationImpact(actor(desk), {
      clinicianId: therapist.id, fromDate: '2026-09-01', toDate: '2026-09-01',
      startMinute: 800, endMinute: 1020, // 13:20, exactly when that session ends
    });
    expect(touching).toEqual([]);
  });

  it('applies the hours to every day of a multi-day absence', async () => {
    const week1 = await makeClient(therapist.id, { code: 'TC-WEEK-1' });
    const week2 = await makeClient(therapist.id, { code: 'TC-WEEK-2' });
    await book(week1.id, 600, '2026-09-01');
    await book(week2.id, 840, '2026-09-08');

    const impact = await vacationImpact(actor(desk), {
      clinicianId: therapist.id, fromDate: '2026-09-01', toDate: '2026-09-08',
      startMinute: 780, endMinute: 1020,
    });
    expect(impact.map((i) => i.client.code)).toEqual(['TC-WEEK-2']);
  });

  it('still takes the whole day when the absence names no hours', async () => {
    const morning = await makeClient(therapist.id, { code: 'TC-MORNING' });
    const afternoon = await makeClient(therapist.id, { code: 'TC-AFTERNOON' });
    await book(morning.id, 600);
    await book(afternoon.id, 840);

    const impact = await vacationImpact(actor(desk), {
      clinicianId: therapist.id, fromDate: '2026-09-01', toDate: '2026-09-01',
      startMinute: null, endMinute: null,
    });
    expect(impact.map((i) => i.client.code)).toEqual(['TC-MORNING', 'TC-AFTERNOON']);
  });

  it('leaves already-cancelled sessions out of the work-list', async () => {
    const c = await makeClient(therapist.id);
    const appt = await book(c.id, 900);
    await cancelAppointment(actor(desk), appt.id, {
      clock: fixedClock(new Date('2026-08-20T12:00:00Z')),
    });
    expect(await vacationImpact(actor(desk), {
      clinicianId: therapist.id, fromDate: '2026-09-01', toDate: '2026-09-05',
    })).toEqual([]);
  });
});

describe('the continuity queue', () => {
  const completeASessionOn = async (clientId: string, date: string) => {
    const appt = await book(clientId, 900, date);
    await setStatus(actor(desk), appt.id, 'arrived');
    await setStatus(actor(desk), appt.id, 'in_session');
    await setStatus(actor(desk), appt.id, 'completed');
  };

  it('lists clients whose last session completed with nothing booked', async () => {
    const lapsed = await makeClient(therapist.id, { code: 'TC-LAPSED' });
    await completeASessionOn(lapsed.id, '2026-09-01');

    const queue = await continuityQueue(actor(desk), { clock: fixedClock('2026-10-06T12:00:00Z') });
    expect(queue.map((c) => c.code)).toEqual(['TC-LAPSED']);
    expect(queue[0]!.daysSince).toBe(34); // 1 Sep 15:00 to 6 Oct 12:00 is 34 whole days
  });

  it('leaves out anyone with a future session on the books', async () => {
    const ongoing = await makeClient(therapist.id, { code: 'TC-ONGOING' });
    await completeASessionOn(ongoing.id, '2026-09-01');
    await book(ongoing.id, 900, '2026-10-13');
    expect(await continuityQueue(actor(desk), { clock: fixedClock('2026-10-06T12:00:00Z') })).toEqual([]);
  });

  it('leaves out anyone still inside the gap', async () => {
    const recent = await makeClient(therapist.id);
    await completeASessionOn(recent.id, '2026-09-29');
    expect(await continuityQueue(actor(desk), { clock: fixedClock('2026-10-06T12:00:00Z') })).toEqual([]);
  });

  it('leaves out a client who has never had a session — that is intake work', async () => {
    await makeClient(therapist.id, { code: 'TC-NEVER' });
    expect(await continuityQueue(actor(desk), { clock: fixedClock('2026-10-06T12:00:00Z') })).toEqual([]);
  });

  it('shows a clinician only their own', async () => {
    const other = await makeUser('therapist');
    const mine = await makeClient(therapist.id, { code: 'TC-MINE' });
    const theirs = await makeClient(other.id, { code: 'TC-THEIRS' });
    await completeASessionOn(mine.id, '2026-09-01');
    await prisma.availability.create({ data: { userId: other.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
    const appt = await bookAppointment(actor(desk), {
      clientId: theirs.id, clinicianId: other.id, date: '2026-09-01',
      startMinute: 900, type: 'standard', modality: 'in_person',
    });
    await setStatus(actor(desk), appt.id, 'arrived');
    await setStatus(actor(desk), appt.id, 'in_session');
    await setStatus(actor(desk), appt.id, 'completed');

    const clock = fixedClock('2026-10-06T12:00:00Z');
    expect((await continuityQueue(actor(therapist), { clock })).map((c) => c.code)).toEqual(['TC-MINE']);
    expect((await continuityQueue(actor(desk), { clock })).map((c) => c.code).sort()).toEqual(['TC-MINE', 'TC-THEIRS']);
  });

  it('sorts the longest gap first, because that is the one that got away', async () => {
    const older = await makeClient(therapist.id, { code: 'TC-OLDER' });
    const newer = await makeClient(therapist.id, { code: 'TC-NEWER' });
    await completeASessionOn(older.id, '2026-08-04');
    await completeASessionOn(newer.id, '2026-09-01');
    const queue = await continuityQueue(actor(desk), { clock: fixedClock('2026-10-06T12:00:00Z') });
    expect(queue.map((c) => c.code)).toEqual(['TC-OLDER', 'TC-NEWER']);
  });
});

describe('the waitlist', () => {
  it('matches on weekday and time window, and never books', async () => {
    const wants = await makeClient(therapist.id, { code: 'TC-WANTS' });
    const wrongDay = await makeClient(therapist.id, { code: 'TC-WRONGDAY' });
    const wrongTime = await makeClient(therapist.id, { code: 'TC-WRONGTIME' });
    const tooEarly = await makeClient(therapist.id, { code: 'TC-TOOEARLY' });
    const onTheDot = await makeClient(therapist.id, { code: 'TC-ONTHEDOT' });
    const anyTime = await makeClient(therapist.id, { code: 'TC-ANY' });

    await prisma.waitlistEntry.createMany({
      data: [
        { clientId: wants.id, weekdays: [2], earliestMinute: 840, latestMinute: 1020 },
        { clientId: wrongDay.id, weekdays: [4] },
        { clientId: wrongTime.id, weekdays: [2], earliestMinute: 540, latestMinute: 660 },
        // Nothing before 5pm. Every other entry here is excluded by the *upper*
        // bound or the weekday, so without this one the "not before" half of the
        // window was never what decided a match.
        { clientId: tooEarly.id, weekdays: [2], earliestMinute: 1020 },
        // Free from 3pm, and the slot is 3pm: the bound includes its own edge,
        // the same way the late-cancel window does.
        { clientId: onTheDot.id, weekdays: [2], earliestMinute: 900 },
        { clientId: anyTime.id },
      ],
    });

    const matches = await waitlistMatches(actor(desk), { date: '2026-09-01', startMinute: 900 });
    expect(matches.map((m) => m.client.code).sort()).toEqual(['TC-ANY', 'TC-ONTHEDOT', 'TC-WANTS']);
    expect(await prisma.appointment.count()).toBe(0);
  });
});

describe('the auditor', () => {
  const someActivity = async () => {
    const c = await makeClient(therapist.id);
    await book(c.id, 900);
    await guarded({ actor: actor(admin, 'welfare check'), action: 'read', resource: 'client', clientId: c.id }, async () => null);
    await guarded({ actor: actor(desk), action: 'read', resource: 'process_note', clientId: c.id }, async () => null)
      .catch(() => null);
    return c;
  };

  it('reads the log', async () => {
    await someActivity();
    const { rows, total } = await queryAuditLog(actor(auditorUser));
    expect(total).toBeGreaterThan(0);
    expect(rows.length).toBe(total);
  });

  it('filters to break-glass, which is what an audit is usually for', async () => {
    await someActivity();
    const { rows } = await queryAuditLog(actor(auditorUser), { flaggedOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ breakGlass: true, reason: 'welfare check' });
  });

  it('filters to denials', async () => {
    await someActivity();
    const { rows } = await queryAuditLog(actor(auditorUser), { deniedOnly: true });
    expect(rows.every((r) => r.allowed === false)).toBe(true);
    expect(rows.some((r) => r.resource === 'process_note')).toBe(true);
  });

  it('answers "who touched client X"', async () => {
    const c = await someActivity();
    const { rows } = await queryAuditLog(actor(auditorUser), { clientId: c.id });
    expect(rows.every((r) => r.clientId === c.id)).toBe(true);
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([desk.id, admin.id]));
  });

  it('pages through the log in the same order as reading it whole', async () => {
    // Scoped to one client, because reading the audit log is itself an audited
    // event: an unfiltered comparison grows a row between the two queries it is
    // comparing. Log reads carry no clientId, so this set holds still.
    const c = await someActivity();
    const forClient = { clientId: c.id };
    const all = await queryAuditLog(actor(auditorUser), forClient);
    expect(all.total).toBeGreaterThan(2);
    expect(all.nextCursor).toBeNull();

    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await queryAuditLog(actor(auditorUser), { ...forClient, limit: 2, ...(cursor ? { cursor } : {}) });
      paged.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);

    // Same rows, same order, none seen twice and none skipped at a boundary.
    expect(paged).toEqual(all.rows.map((r) => r.id));

    // A page that exactly exhausts the rows is the last page. Offering a cursor
    // here sends the reader to an empty one.
    const exact = await queryAuditLog(actor(auditorUser), { ...forClient, limit: all.total });
    expect(exact.rows).toHaveLength(all.total);
    expect(exact.nextCursor).toBeNull();
  });

  it('filters on a date range with only one end given', async () => {
    await someActivity();
    const since = await queryAuditLog(actor(auditorUser), { from: new Date('2099-01-01') });
    expect(since.rows).toHaveLength(0);
    const until = await queryAuditLog(actor(auditorUser), { to: new Date('2099-01-01') });
    expect(until.rows.length).toBe(until.total);
  });

  it('cannot read a client record', async () => {
    const c = await someActivity();
    await expect(
      guarded({ actor: actor(auditorUser), action: 'read', resource: 'client', clientId: c.id }, async () => null),
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it('is the only role with the log — including the manager who breaks glass', async () => {
    await someActivity();
    for (const who of [desk, therapist, admin]) {
      await expect(queryAuditLog(actor(who))).rejects.toBeInstanceOf(Forbidden);
    }
    await expect(queryAuditLog(actor(admin, 'i would like to see'))).rejects.toBeInstanceOf(Forbidden);
  });

  it('pages', async () => {
    const c = await makeClient(therapist.id);
    for (let i = 0; i < 5; i++) {
      await guarded({ actor: actor(desk), action: 'read', resource: 'client', clientId: c.id }, async () => null);
    }
    const first = await queryAuditLog(actor(auditorUser), { limit: 2 });
    expect(first.rows).toHaveLength(2);
    const second = await queryAuditLog(actor(auditorUser), { limit: 2, cursor: first.nextCursor! });
    expect(second.rows).toHaveLength(2);
    expect(second.rows.map((r) => r.id)).not.toEqual(first.rows.map((r) => r.id));
  });

  describe('CSV export', () => {
    it('carries ids and no PHI', async () => {
      const c = await someActivity();
      const { rows } = await queryAuditLog(actor(auditorUser));
      const csv = toCsv(rows);
      expect(csv.split('\n')[0]).toContain('actorId,actorRole,action,resource');
      expect(csv).not.toContain(c.firstName === 'Test' ? c.lastName : c.firstName);
    });

    it('quotes a reason containing a comma', () => {
      expect(toCsv([{ at: new Date('2026-09-01T00:00:00Z'), reason: 'crisis, clinician away' }]))
        .toContain('"crisis, clinician away"');
    });

    it('defuses a spreadsheet formula in a free-text field', () => {
      const csv = toCsv([{ reason: '=HYPERLINK("http://evil","click")' }]);
      expect(csv).toContain(`"'=HYPERLINK`);
    });
  });
});

describe('the utilization report', () => {
  const quarter = async () => {
    const c = await makeClient(therapist.id);
    const done = await book(c.id, 540);
    await setStatus(actor(desk), done.id, 'arrived');
    await setStatus(actor(desk), done.id, 'in_session');
    await setStatus(actor(desk), done.id, 'completed');

    const missed = await book(c.id, 660);
    await setStatus(actor(desk), missed.id, 'no_show');

    const late = await book(c.id, 780);
    await cancelAppointment(actor(desk), late.id, { clock: fixedClock(new Date('2026-09-01T16:00:00Z')) });

    await bookAppointment(actor(desk), {
      clientId: c.id, clinicianId: therapist.id, date: '2026-09-01',
      startMinute: 900, type: 'standard', modality: 'telehealth',
    });
  };

  it('counts sessions, rates and room utilization', async () => {
    await quarter();
    const report = await utilizationReport(actor(admin), { from: '2026-09-01', to: '2026-09-04' });
    expect(report.totals).toMatchObject({ booked: 4, completed: 1, noShow: 1, lateCancelled: 1, telehealth: 1 });
    expect(report.rates.noShow).toBe(0.25);
    expect(report.clinicians[0]).toMatchObject({ id: therapist.id, completed: 1, telehealth: 1 });
    const used = report.rooms.filter((r) => r.bookedMinutes > 0);
    expect(used.length).toBeGreaterThan(0);
    expect(used[0]!.utilization).toBeGreaterThan(0);
  });

  it('counts every ending against the clinician who had it, not only the good ones', async () => {
    // The case above asserts `completed` and `telehealth` on the clinician row
    // and leaves the other three counters unexamined, so each could have been
    // counting the wrong status entirely.
    await quarter();
    const report = await utilizationReport(actor(admin), { from: '2026-09-01', to: '2026-09-04' });
    expect(report.totals).toMatchObject({ cancelled: 0 });
    expect(report.clinicians[0]).toMatchObject({
      id: therapist.id, booked: 4, completed: 1, noShow: 1, lateCancelled: 1, cancelled: 0, telehealth: 1,
      minutes: 50, // one completed standard session, and only completed ones count
    });
  });

  it("measures a room against the practice's working day", async () => {
    // Tuesday to Friday is four weekdays at eight hours: 1,920 minutes. Two
    // 50-minute in-person sessions were held in the room — the late cancel gave
    // its hour back and the telehealth session never needed one. Asserting only
    // that utilization is above zero would hold for any capacity at all, which
    // is what a percentage against midnight-to-midnight would quietly become.
    await quarter();
    const report = await utilizationReport(actor(admin), { from: '2026-09-01', to: '2026-09-04' });
    const room = report.rooms.find((r) => r.bookedMinutes > 0)!;
    expect(room.capacityMinutes).toBe(4 * 8 * 60);
    expect(room.bookedMinutes).toBe(100);
    expect(room.utilization).toBe(0.0521);

    // And the three rooms nobody used read as empty rather than nearly empty.
    const idle = report.rooms.filter((r) => r.id !== room.id);
    expect(idle).toHaveLength(3);
    expect(idle.every((r) => r.bookedMinutes === 0 && r.utilization === 0)).toBe(true);
  });

  it('gives a room capacity for weekdays only, however the range falls', async () => {
    // Monday 31 August to Saturday 5 September: six days, five of them working.
    // A range that stops on a Friday cannot tell an off-by-one in the weekday
    // test from a correct one, because it contains no weekend to get wrong.
    await quarter();
    const report = await utilizationReport(actor(admin), { from: '2026-08-31', to: '2026-09-05' });
    expect(report.rooms[0]!.capacityMinutes).toBe(5 * 8 * 60);
  });

  it('reports rates of zero for a range with nothing in it', async () => {
    // Every rate divides by the number booked. Nothing had ever asked what the
    // report does when that is zero.
    const report = await utilizationReport(actor(admin), { from: '2026-10-05', to: '2026-10-09' });
    expect(report.totals.booked).toBe(0);
    expect(report.rates).toEqual({ noShow: 0, lateCancel: 0, telehealth: 0 });
  });

  it('shows no capacity, and no utilization, for a range with no working days', async () => {
    // Saturday and Sunday. Dividing by a capacity of zero has to yield nothing,
    // not every room reported as fully booked.
    const report = await utilizationReport(actor(admin), { from: '2026-09-05', to: '2026-09-06' });
    expect(report.rooms[0]).toMatchObject({ capacityMinutes: 0, utilization: 0 });
  });

  it('does not name a single client', async () => {
    const c = await makeClient(therapist.id, { code: 'TC-PRIVATE' });
    await book(c.id, 540);
    const report = await utilizationReport(actor(admin), { from: '2026-09-01', to: '2026-09-04' });
    expect(JSON.stringify(report)).not.toContain('TC-PRIVATE');
    expect(JSON.stringify(report)).not.toContain(c.lastName);
  });

  it('is not front-desk business', async () => {
    await expect(utilizationReport(actor(desk), { from: '2026-09-01', to: '2026-09-04' }))
      .rejects.toBeInstanceOf(Forbidden);
  });

  it('buckets completed sessions by calendar week', async () => {
    await quarter();
    const weeks = await weeklyVolume(actor(admin), { from: '2026-08-31', to: '2026-09-30' });
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatchObject({ week: '2026-08-31', sessions: 1 });
  });

  it('starts weeks on Monday', () => {
    expect(weekStart('2026-09-01')).toBe('2026-08-31'); // Tuesday -> Monday
    expect(weekStart('2026-08-31')).toBe('2026-08-31');
    expect(weekStart('2026-09-06')).toBe('2026-08-31'); // Sunday -> that Monday
  });
});
