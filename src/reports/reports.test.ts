import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { guarded } from '../auth/guard';
import { fixedClock, DAY, HOUR } from '../clock';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { bookAppointment } from '../scheduling/booking';
import { cancelAppointment, setStatus, waiveFee } from '../scheduling/lifecycle';
import { continuityQueue, unconfirmedSoon, vacationImpact, waitlistMatches } from '../scheduling/worklists';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { confirmationTrail, noResponseFees, queryAuditLog, toCsv } from './audit';
import { runReminderHorizon } from '../scheduling/reminders';
import { runNonResponseSweep } from '../scheduling/nonresponse';
import { confirmAppointment, declineAppointment } from '../portal/service';
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

/**
 * P1-1. The half of the confirmation feature that is not the money, and the
 * half a practice should ship first. A list somebody works with a phone.
 */
describe('the unconfirmed work-list', () => {
  const START = new Date('2026-09-01T19:00:00Z');
  const DAY_BEFORE = () => fixedClock(new Date(START.getTime() - DAY));

  async function booked(startMinute: number, opts: { reminderPreference?: 'email' | 'none' } = {}) {
    const client = await makeClient(therapist.id);
    await prisma.client.update({
      where: { id: client.id },
      data: { email: 'tc@example.test', phone: '555-0100', ...opts },
    });
    return bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: '2026-09-01', startMinute,
      type: 'standard', modality: 'in_person',
      clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });
  }

  it('lists sessions starting soon that nobody has answered for, oldest start first', async () => {
    const late = await booked(16 * 60);
    const early = await booked(10 * 60);
    await runReminderHorizon(DAY_BEFORE());

    const list = await unconfirmedSoon(actor(desk), { clock: DAY_BEFORE(), withinHours: 48 });
    expect(list.map((r) => r.id)).toEqual([early.id, late.id]);
    expect(list[0]!.client.phone).toBe('555-0100');
    expect(list[0]!.stagesSent).toEqual(['d5', 'd1']);
  });

  it('drops a session the moment the client answers', async () => {
    const appt = await booked(15 * 60);
    await runReminderHorizon(DAY_BEFORE());
    expect(await unconfirmedSoon(actor(desk), { clock: DAY_BEFORE() })).toHaveLength(1);

    const link = await prisma.portalLink.findFirstOrThrow({ where: { clientId: appt.clientId } });
    await confirmAppointment(link.token, appt.id, { clock: DAY_BEFORE() });

    expect(await unconfirmedSoon(actor(desk), { clock: DAY_BEFORE() })).toEqual([]);
  });

  it('keeps the client nobody may charge, and says so', async () => {
    // Q4: the exemption is structural in code, and the operational answer is a
    // phone call. Hiding these rows would turn a safety setting into a client
    // nobody rings.
    const quiet = await booked(15 * 60, { reminderPreference: 'none' });
    await runReminderHorizon(DAY_BEFORE());

    const list = await unconfirmedSoon(actor(desk), { clock: DAY_BEFORE() });
    expect(list.map((r) => r.id)).toEqual([quiet.id]);
    expect(list[0]).toMatchObject({ neverAsked: true, stagesSent: [] });
  });

  it('respects the window rather than listing the whole quarter', async () => {
    await booked(15 * 60);
    await runReminderHorizon(DAY_BEFORE());
    expect(await unconfirmedSoon(actor(desk), { clock: DAY_BEFORE(), withinHours: 2 })).toEqual([]);
  });

  it('narrows a clinician to their own caseload and denies the auditor', async () => {
    await booked(15 * 60);
    await runReminderHorizon(DAY_BEFORE());

    const other = await makeUser('therapist');
    await prisma.availability.create({ data: { userId: other.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
    expect(await unconfirmedSoon(actor(other), { clock: DAY_BEFORE() })).toEqual([]);
    expect(await unconfirmedSoon(actor(therapist), { clock: DAY_BEFORE() })).toHaveLength(1);

    await expect(unconfirmedSoon(actor(auditorUser), { clock: DAY_BEFORE() })).rejects.toBeInstanceOf(Forbidden);
  });
});

/**
 * P1-4. What the policy did, for the person who has to decide whether it should
 * keep doing it. Risk 1 is answerable only from data, and a number nobody can
 * find is a number nobody will check.
 */
describe('the confirmation report', () => {
  const START = new Date('2026-09-01T19:00:00Z');
  const RANGE = { from: '2026-08-25', to: '2026-09-08' };

  /** One session, walked to whichever ending the test needs. */
  async function session(startMinute: number, ending: 'confirmed' | 'declined' | 'silent' | 'never_asked') {
    const client = await makeClient(therapist.id);
    await prisma.client.update({
      where: { id: client.id },
      data: ending === 'never_asked'
        ? { reminderPreference: 'none' }
        : { email: 'tc@example.test' },
    });
    const appt = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: '2026-09-01', startMinute,
      type: 'standard', modality: 'in_person',
      clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 2 * DAY)));

    if (ending === 'confirmed' || ending === 'declined') {
      const link = await prisma.portalLink.findFirstOrThrow({ where: { clientId: client.id } });
      const at = fixedClock(new Date(appt.startAt.getTime() - 2 * DAY));
      if (ending === 'confirmed') await confirmAppointment(link.token, appt.id, { clock: at });
      else await declineAppointment(link.token, appt.id, { clock: at, reason: 'cannot_make_it' });
    }
    if (ending === 'silent') {
      await runNonResponseSweep(fixedClock(new Date(appt.startAt.getTime() + 30 * 60_000)));
    }
    return appt;
  }

  it('counts every answer, and the silence, and the sessions nobody was asked', async () => {
    await session(9 * 60, 'confirmed');
    await session(10 * 60, 'declined');
    await session(11 * 60, 'silent');
    await session(12 * 60, 'never_asked');

    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.totals).toMatchObject({
      confirmed: 1, declined: 1, noResponse: 1, notRequired: 1,
    });
    // Rates are against what the practice was allowed to ask, not against
    // everything booked: a client on "no messages" was never in the
    // denominator of a question nobody put to them.
    expect(report.asked).toBe(3);
    expect(report.rates.confirmed).toBeCloseTo(1 / 3);
  });

  it('reports the money the policy generated, and only that money', async () => {
    await session(9 * 60, 'silent');
    // A no-show a person marked, which is the practice's ordinary policy and
    // belongs to the utilization report rather than to this one.
    const byHand = await session(10 * 60, 'confirmed');
    await setStatus(actor(desk), byHand.id, 'no_show');

    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.totals.charged).toBe(1);
    expect(report.totals.feeCents).toBe(9000);
  });

  it('takes a waived fee out of the total and keeps the count of it', async () => {
    const silent = await session(9 * 60, 'silent');
    await waiveFee(actor(admin), silent.id, 'practice_error');

    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.totals).toMatchObject({ charged: 0, waived: 1, feeCents: 0 });
  });

  it('splits by clinician, because the question is usually about one caseload', async () => {
    await session(9 * 60, 'confirmed');
    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.byClinician).toHaveLength(1);
    expect(report.byClinician[0]).toMatchObject({ name: therapist.name, confirmed: 1 });
  });

  it('is the practice manager\'s, and names no client anywhere in it', async () => {
    const appt = await session(9 * 60, 'silent');
    const client = await prisma.client.findUniqueOrThrow({ where: { id: appt.clientId } });

    const report = await confirmationReport(actor(admin), RANGE);
    const text = JSON.stringify(report);
    for (const secret of [client.firstName, client.lastName, client.code]) {
      expect(text).not.toContain(secret);
    }
    await expect(confirmationReport(actor(desk), RANGE)).rejects.toBeInstanceOf(Forbidden);
  });
});

/**
 * P1-5. One vocabulary for one question. The decline reuses the reschedule
 * request's four codes rather than inventing a parallel list.
 */
describe('why a client declined', () => {
  const START = new Date('2026-09-01T19:00:00Z');

  it('records the code the client chose, with no free text anywhere', async () => {
    const client = await makeClient(therapist.id);
    await prisma.client.update({ where: { id: client.id }, data: { email: 'tc@example.test' } });
    const appt = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: '2026-09-01', startMinute: 9 * 60,
      type: 'standard', modality: 'in_person',
      clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 2 * DAY)));
    const link = await prisma.portalLink.findFirstOrThrow({ where: { clientId: client.id } });

    const out = await declineAppointment(link.token, appt.id, {
      clock: fixedClock(new Date(appt.startAt.getTime() - 2 * DAY)),
      reason: 'need_a_different_time',
    });
    expect(out.cancelReason).toBe('need_a_different_time');
    expect(out.confirmation).toBe('declined');

    // And it stays out of the audit log, which carries the answer as a code
    // and never the operational text beside it.
    const rows = await prisma.auditEvent.findMany({ where: { resourceId: appt.id } });
    expect(rows.map((r) => r.reason)).toContain('declined');
    expect(JSON.stringify(rows)).not.toContain('need_a_different_time');
  });

  it('still declines without one, because a keyword reply carries none', async () => {
    const client = await makeClient(therapist.id);
    await prisma.client.update({ where: { id: client.id }, data: { email: 'tc2@example.test' } });
    const appt = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: '2026-09-01', startMinute: 10 * 60,
      type: 'standard', modality: 'in_person',
      clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });
    await runReminderHorizon(fixedClock(new Date(START.getTime() - 2 * DAY)));
    const link = await prisma.portalLink.findFirstOrThrow({ where: { clientId: client.id } });

    const out = await declineAppointment(link.token, appt.id, {
      clock: fixedClock(new Date(appt.startAt.getTime() - 2 * DAY)),
    });
    expect(out.status).toBe('cancelled');
    expect(out.cancelReason).toBe('client declined');
  });
});

/**
 * P0-9. The capstone question, asked by somebody who was not there: this client
 * was charged for not answering — show me that they were asked, that they never
 * did, and who decided that silence was the answer.
 */
describe('the evidence behind an automatic charge', () => {
  const START = new Date('2026-09-01T19:00:00Z');

  /** Book with a month's notice, run the cadence to its end, then sweep. */
  async function charged(opts: { answer?: 'confirm'; startMinute?: number } = {}) {
    const client = await makeClient(therapist.id);
    await prisma.client.update({ where: { id: client.id }, data: { email: 'tc@example.test' } });
    const appt = await bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: '2026-09-01',
      startMinute: opts.startMinute ?? 15 * 60, type: 'standard', modality: 'in_person',
      clock: fixedClock(new Date(START.getTime() - 30 * DAY)),
    });

    for (const at of [5 * DAY, DAY, 3 * HOUR]) {
      await runReminderHorizon(fixedClock(new Date(START.getTime() - at)));
    }
    if (opts.answer === 'confirm') {
      const link = await prisma.portalLink.findFirstOrThrow({ where: { clientId: client.id } });
      await confirmAppointment(link.token, appt.id, {
        clock: fixedClock(new Date(START.getTime() - 2 * HOUR)),
      });
    }
    await runNonResponseSweep(fixedClock(new Date(START.getTime() + 20 * 60_000)));
    return appt;
  }

  it('shows three sends, no answers, one determination and one fee', async () => {
    const appt = await charged();
    const trail = await confirmationTrail(actor(auditorUser), appt.id);

    expect(trail).toMatchObject({
      sends: 3,
      stages: ['d5', 'd1', 'd0'],
      answers: 0,
      determinations: 1,
      status: 'no_show',
      confirmation: 'no_response',
      feeCents: 9000,
      waived: false,
    });
  });

  it('shows the answer where there was one, and no determination', async () => {
    const appt = await charged({ answer: 'confirm' });
    const trail = await confirmationTrail(actor(auditorUser), appt.id);

    expect(trail).toMatchObject({
      answers: 1, determinations: 0, confirmation: 'confirmed', feeCents: null,
    });
  });

  it('carries ids, codes and cents — never a name, a number or a body', async () => {
    const appt = await charged();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: appt.clientId } });
    const trail = await confirmationTrail(actor(auditorUser), appt.id);

    const text = JSON.stringify(trail);
    for (const secret of [client.firstName, client.lastName, client.code, client.email!]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('Appointment reminder');
  });

  it('filters to the charges nobody decided', async () => {
    const charged1 = await charged();
    await charged({ answer: 'confirm', startMinute: 16 * 60 });

    const rows = await noResponseFees(actor(auditorUser));
    expect(rows.map((r) => r.id)).toEqual([charged1.id]);
    expect(rows[0]).toMatchObject({ chargeFeeCents: 9000, feeWaivedAt: null });
  });

  it('is the auditor\'s, and not the practice manager\'s', async () => {
    const appt = await charged();
    await expect(confirmationTrail(actor(admin), appt.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(noResponseFees(actor(desk))).rejects.toBeInstanceOf(Forbidden);

    const denials = await prisma.auditEvent.findMany({ where: { resource: 'audit_log', allowed: false } });
    expect(denials.map((d) => d.actorRole).sort()).toEqual(['admin', 'front_desk']);
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
