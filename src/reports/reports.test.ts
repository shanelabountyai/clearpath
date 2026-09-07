import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { guarded } from '../auth/guard';
import { fixedClock, DAY, HOUR } from '../clock';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { bookAppointment } from '../scheduling/booking';
import { cancelAppointment, setStatus, waiveFee } from '../scheduling/lifecycle';
import { continuityQueue, unconfirmedSoon, vacationImpact, waitlistMatches, waitlistOpenings } from '../scheduling/worklists';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { queryAuditLog, toCsv } from './audit';
import { confirmationReport, utilizationReport, weeklyVolume, weekStart } from './utilization';

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

describe('the unconfirmed work-list', () => {
  /** ~31 hours before the 15:00 Tuesday, and ~7 days before the one after. */
  const clock = fixedClock('2026-08-31T12:00:00Z');

  it('lists every unanswered session in the window, soonest first, with a number', async () => {
    const silent = await makeClient(therapist.id, { code: 'TC-SILENT' });
    await prisma.client.update({ where: { id: silent.id }, data: { phone: '555-0142' } });
    const never = await makeClient(therapist.id, { code: 'TC-NEVER' });
    const answered = await makeClient(therapist.id, { code: 'TC-ANSWERED' });
    const later = await makeClient(therapist.id, { code: 'TC-LATER' });

    const asked = await book(silent.id, 600);
    await prisma.appointment.update({ where: { id: asked.id }, data: { confirmation: 'pending' } });
    await book(never.id, 900);
    const yes = await book(answered.id, 660);
    await prisma.appointment.update({ where: { id: yes.id }, data: { confirmation: 'confirmed' } });
    await book(later.id, 900, '2026-09-08');

    const list = await unconfirmedSoon(actor(desk), { clock });
    expect(list.map((a) => a.client.code)).toEqual(['TC-SILENT', 'TC-NEVER']);
    expect(list[0]!.client.phone).toBe('555-0142');
  });

  it('drops an hour front desk has already confirmed by hand', async () => {
    const c = await makeClient(therapist.id, { code: 'TC-BYHAND' });
    const appt = await book(c.id, 900);
    expect(await unconfirmedSoon(actor(desk), { clock })).toHaveLength(1);

    await setStatus(actor(desk), appt.id, 'confirmed');
    expect(await unconfirmedSoon(actor(desk), { clock })).toEqual([]);
  });

  /**
   * The case P1-3 leaves behind: a keyword decline inside the fee window
   * records the answer and does not free the room, because a text message
   * cannot carry a fee disclosure. That hour still needs a phone call.
   */
  it('keeps a declined session that is still standing', async () => {
    const c = await makeClient(therapist.id, { code: 'TC-SAIDNO' });
    const appt = await book(c.id, 900);
    await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation: 'declined' } });

    expect((await unconfirmedSoon(actor(desk), { clock })).map((a) => a.confirmation)).toEqual(['declined']);
  });
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
    const anyTime = await makeClient(therapist.id, { code: 'TC-ANY' });

    await prisma.waitlistEntry.createMany({
      data: [
        { clientId: wants.id, weekdays: [2], earliestMinute: 840, latestMinute: 1020 },
        { clientId: wrongDay.id, weekdays: [4] },
        { clientId: wrongTime.id, weekdays: [2], earliestMinute: 540, latestMinute: 660 },
        { clientId: anyTime.id },
      ],
    });

    const matches = await waitlistMatches(actor(desk), { date: '2026-09-01', startMinute: 900 });
    expect(matches.map((m) => m.client.code).sort()).toEqual(['TC-ANY', 'TC-WANTS']);
    expect(await prisma.appointment.count()).toBe(0);
  });

  /**
   * The join P2-2 is about: an hour the record already knows is going spare,
   * beside the people who said they want one.
   */
  it('reads the openings out of confirmation and cancellation state, and never offers a client their own hour', async () => {
    const clock = fixedClock('2026-08-27T12:00:00Z');
    const saidNo = await makeClient(therapist.id, { code: 'TC-SAIDNO' });
    const gaveItBack = await makeClient(therapist.id, { code: 'TC-CANCELLED' });
    const coming = await makeClient(therapist.id, { code: 'TC-COMING' });
    const wants = await makeClient(therapist.id, { code: 'TC-WANTS' });
    const wrongDay = await makeClient(therapist.id, { code: 'TC-WRONGDAY' });

    // 15:00 Tuesday: the client declined, so the hour is still on the books.
    const declined = await book(saidNo.id, 900);
    await prisma.appointment.update({ where: { id: declined.id }, data: { confirmation: 'declined' } });
    // 10:00 the same day: actually cancelled, so the hour is free.
    const cancelled = await book(gaveItBack.id, 600);
    await cancelAppointment(actor(desk), cancelled.id, { clock });
    // And one nobody is giving up.
    await book(coming.id, 660);

    await prisma.waitlistEntry.createMany({
      data: [
        { clientId: wants.id, weekdays: [2] },
        { clientId: wrongDay.id, weekdays: [4] },
        // On the list, and also the person who declined the 15:00.
        { clientId: saidNo.id, weekdays: [2] },
      ],
    });

    const open = await waitlistOpenings(actor(desk), { clock });
    expect(open.map((o) => o.client.code)).toEqual(['TC-CANCELLED', 'TC-SAIDNO']);

    const [free, stillBooked] = open;
    expect(free!.freed).toBe(true);
    expect(stillBooked!.freed).toBe(false);
    // 15:00 local on 1 Sep (19:00Z) from midday UTC on 27 Aug — five days and
    // seven hours, which is the `d5` reminder still ahead of it.
    expect(stillBooked!.noticeHours).toBe(5 * 24 + 7);
    // The Tuesday entries, minus the client whose hour it is.
    expect(stillBooked!.matches.map((m) => m.client.code)).toEqual(['TC-WANTS']);
    expect(free!.matches.map((m) => m.client.code)).toEqual(['TC-WANTS', 'TC-SAIDNO']);
  });

  it('offers nothing from an hour still standing and answered', async () => {
    const clock = fixedClock('2026-08-27T12:00:00Z');
    const c = await makeClient(therapist.id, { code: 'TC-PENDING' });
    const appt = await book(c.id, 900);
    await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation: 'pending' } });
    expect(await waitlistOpenings(actor(desk), { clock })).toEqual([]);
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

describe('the confirmation report', () => {
  const RANGE = { from: '2026-09-01' as const, to: '2026-09-04' as const };

  /**
   * One of every state the loop can leave behind, plus a second clinician, so
   * the per-clinician split and the practice-wide totals cannot both be right
   * by accident.
   */
  const loop = async () => {
    const c = await makeClient(therapist.id);

    const yes = await book(c.id, 540);
    await prisma.appointment.update({ where: { id: yes.id }, data: { confirmation: 'confirmed' } });

    const no = await book(c.id, 600);
    await prisma.appointment.update({
      where: { id: no.id },
      data: { confirmation: 'declined', declineReason: 'prefer_later' },
    });

    const quiet = await book(c.id, 660);
    await setStatus(actor(desk), quiet.id, 'no_show', { confirmation: 'no_response' });

    const asking = await book(c.id, 720);
    await prisma.appointment.update({ where: { id: asking.id }, data: { confirmation: 'pending' } });

    // Never asked: `reminderPreference: 'none'`, the case the fee rule exempts.
    await book(c.id, 780);
  };

  it('splits the four answers and rates only what was asked and settled', async () => {
    await loop();
    const report = await confirmationReport(actor(admin), RANGE);

    expect(report.totals).toMatchObject({
      confirmed: 1, declined: 1, noResponse: 1, pending: 1, notRequired: 1,
    });
    // 1 of 3 decided. The pending hour and the one nobody was asked about are
    // both excluded — counting either as a miss is the category error the
    // whole feature exists to avoid.
    expect(report.totals.rate).toBe(round4(1 / 3));
    expect(report.clinicians).toHaveLength(1);
    expect(report.clinicians[0]).toMatchObject({ id: therapist.id, confirmed: 1, rate: round4(1 / 3) });
  });

  it('counts only the fee that silence itself produced', async () => {
    await loop();

    // A late cancel is charged whether or not anybody was ever asked, so it
    // must not be credited to this policy.
    const c2 = await makeClient(therapist.id);
    const late = await book(c2.id, 840);
    await cancelAppointment(actor(desk), late.id, { clock: fixedClock(new Date('2026-09-01T13:30:00Z')) });

    const report = await confirmationReport(actor(admin), RANGE);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: late.id } })).chargeFeeCents).toBe(9_000);
    expect(report.totals.feeCents).toBe(9_000); // the no_response no-show, and only it
  });

  it('drops a waived fee out of the total without a second condition', async () => {
    await loop();
    const charged = await prisma.appointment.findFirstOrThrow({ where: { confirmation: 'no_response' } });
    await waiveFee(actor(admin), charged.id, 'practice_error');

    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.totals.feeCents).toBe(0);
    // The silence itself is still on the record. A waiver reverses money, not
    // the fact that nobody answered.
    expect(report.totals.noResponse).toBe(1);
  });

  it('reports decline reasons practice-wide, and omits the ones that said nothing', async () => {
    await loop();
    const c = await makeClient(therapist.id);
    const silent = await book(c.id, 900);
    await prisma.appointment.update({ where: { id: silent.id }, data: { confirmation: 'declined' } });

    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.totals.declined).toBe(2);
    expect(report.declineReasons).toEqual([{ reason: 'prefer_later', count: 1 }]);
  });

  it('names no client, and no answer to anything', async () => {
    const c = await makeClient(therapist.id, { code: 'TC-QUIET' });
    const appt = await book(c.id, 540);
    await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation: 'no_response' } });

    const json = JSON.stringify(await confirmationReport(actor(admin), RANGE));
    expect(json).not.toContain('TC-QUIET');
    expect(json).not.toContain(c.lastName);
    expect(json).not.toContain(c.id);
  });

  it('is not front-desk business either', async () => {
    // A confirmation rate alone would be defensible for front desk. This is a
    // per-clinician breakdown carrying a fee total, so it reads under the same
    // `attendance_history` cell as the report beside it — and the denial is
    // on the record.
    await expect(confirmationReport(actor(desk), RANGE)).rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.auditEvent.count({
      where: { actorId: desk.id, resource: 'attendance_history', allowed: false },
    })).toBe(1);
  });
});

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
