import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { guarded } from '../auth/guard';
import { fixedClock, DAY, HOUR } from '../clock';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { bookAppointment } from '../scheduling/booking';
import { cancelAppointment, setStatus, waiveFee } from '../scheduling/lifecycle';
import { continuityQueue, freedSlots, unconfirmedSoon, unreachableClients, unsupportedFees, vacationImpact, waitlistMatches } from '../scheduling/worklists';
import { actor, deliverOutbox, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { ROLES } from '../auth/permissions';
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

    const matches = await waitlistMatches(actor(desk), {
      date: '2026-09-01', startMinute: 900, clinicianId: therapist.id,
    });
    expect(matches.map((m) => m.client.code).sort()).toEqual(['TC-ANY', 'TC-WANTS']);
    expect(await prisma.appointment.count()).toBe(0);
  });

  /**
   * The rule that outranks every preference the client stated. A waiting client
   * of another therapist fits the day and the hour perfectly and is still not
   * offered it, because the offer would be to see somebody else.
   */
  it('never offers one clinician\u2019s hour to another clinician\u2019s client', async () => {
    const other = await makeUser('therapist');
    const theirs = await makeClient(other.id, { code: 'TC-OTHER' });
    const ours = await makeClient(therapist.id, { code: 'TC-OURS' });
    await prisma.waitlistEntry.createMany({
      data: [
        { clientId: theirs.id, weekdays: [2], earliestMinute: 840, latestMinute: 1020 },
        { clientId: ours.id, weekdays: [2], earliestMinute: 840, latestMinute: 1020 },
      ],
    });

    const matches = await waitlistMatches(actor(desk), {
      date: '2026-09-01', startMinute: 900, clinicianId: therapist.id,
    });
    expect(matches.map((m) => m.client.code)).toEqual(['TC-OURS']);
  });
});

/**
 * P2-2. The freed hour, and who has been waiting for one.
 *
 * `2026-09-01` is a Tuesday and the therapist works 09:00\u201317:00 on it, which is
 * what the shared `beforeEach` sets up. Every clock here is fixed a few days
 * before that, so a cancellation is always in the future.
 */
describe('freed slots', () => {
  const FRIDAY_BEFORE = fixedClock('2026-08-28T12:00:00Z');

  const cancelledSession = async (startMinute = 900, date = '2026-09-01') => {
    const c = await makeClient(therapist.id);
    const appt = await book(c.id, startMinute, date);
    await cancelAppointment(actor(desk), appt.id, { clock: FRIDAY_BEFORE });
    return { client: c, appt };
  };

  it('turns a future cancellation into an opening, with the notice remaining', async () => {
    await cancelledSession();

    const slots = await freedSlots(actor(desk), { clock: FRIDAY_BEFORE });
    expect(slots).toHaveLength(1);
    expect(slots[0]!.date).toBe('2026-09-01');
    expect(slots[0]!.startMinute).toBe(900);
    expect(slots[0]!.clinician.id).toBe(therapist.id);
    expect(slots[0]!.notice).toBe('4 days');
    expect(slots[0]!.fillability).toBe('ample');
  });

  /** A decline is one source of an opening, not the definition of one. */
  it('includes a hour the front desk cancelled, not only a client decline', async () => {
    const { appt } = await cancelledSession();
    const row = await prisma.appointment.findUnique({ where: { id: appt.id } });
    expect(row!.confirmation).toBe('not_required');

    const slots = await freedSlots(actor(desk), { clock: FRIDAY_BEFORE });
    expect(slots).toHaveLength(1);
  });

  it('carries the confirmation through, so a decline is legible as one', async () => {
    const c = await makeClient(therapist.id);
    const appt = await book(c.id, 900);
    await cancelAppointment(actor(desk), appt.id, { clock: FRIDAY_BEFORE, confirmation: 'declined' });

    const slots = await freedSlots(actor(desk), { clock: FRIDAY_BEFORE });
    expect(slots[0]!.confirmation).toBe('declined');
  });

  it('never shows an hour that has already started', async () => {
    await cancelledSession();
    const after = fixedClock('2026-09-01T19:30:00Z');
    expect(await freedSlots(actor(desk), { clock: after })).toEqual([]);
  });

  it('drops an hour somebody was rebooked into, with nothing marked as handled', async () => {
    await cancelledSession();
    expect(await freedSlots(actor(desk), { clock: FRIDAY_BEFORE })).toHaveLength(1);

    const filled = await makeClient(therapist.id);
    await book(filled.id, 900);
    expect(await freedSlots(actor(desk), { clock: FRIDAY_BEFORE })).toEqual([]);
  });

  /**
   * Otherwise the vacation work-list and this one describe the same week in
   * opposite words: fifteen conversations to have, or fifteen hours to sell.
   */
  it('never offers an hour on a day the clinician is away', async () => {
    await cancelledSession();
    await prisma.availabilityOverride.create({
      data: {
        userId: therapist.id, kind: 'unavailable',
        fromDate: new Date('2026-08-31T00:00:00Z'), toDate: new Date('2026-09-05T00:00:00Z'),
        reason: 'Leave',
      },
    });
    expect(await freedSlots(actor(desk), { clock: FRIDAY_BEFORE })).toEqual([]);
  });

  it('never offers an hour outside the clinician\u2019s working pattern', async () => {
    await prisma.availability.deleteMany({ where: { userId: therapist.id } });
    await prisma.availability.create({
      data: { userId: therapist.id, weekday: 2, startMinute: 540, endMinute: 660 },
    });
    await cancelledSession(900);
    expect(await freedSlots(actor(desk), { clock: FRIDAY_BEFORE })).toEqual([]);
  });

  it('counts the same hour once however many cancelled rows point at it', async () => {
    const a = await cancelledSession(900);
    // A second client cancelled out of the same hour: one hour, one opening.
    const b = await makeClient(therapist.id);
    const appt = await prisma.appointment.create({
      data: {
        clientId: b.id, clinicianId: therapist.id, roomId: a.appt.roomId,
        startAt: a.appt.startAt, endAt: a.appt.endAt, bookedAt: a.appt.bookedAt,
        status: 'cancelled',
      },
    });
    expect(appt.id).not.toBe(a.appt.id);

    const slots = await freedSlots(actor(desk), { clock: FRIDAY_BEFORE });
    expect(slots).toHaveLength(1);
  });

  it('attaches the waiting clients who could take it, longest wait first', async () => {
    const { client: gaveItUp } = await cancelledSession(900);
    const first = await makeClient(therapist.id, { code: 'TC-FIRST' });
    const second = await makeClient(therapist.id, { code: 'TC-SECOND' });
    const mornings = await makeClient(therapist.id, { code: 'TC-MORNINGS' });

    await prisma.waitlistEntry.create({
      data: { clientId: first.id, weekdays: [2], createdAt: new Date('2026-07-01T00:00:00Z') },
    });
    await prisma.waitlistEntry.create({
      data: { clientId: second.id, createdAt: new Date('2026-08-01T00:00:00Z') },
    });
    await prisma.waitlistEntry.create({
      data: { clientId: mornings.id, latestMinute: 660 },
    });
    // The person who just gave the hour back is on the list and is not offered it.
    await prisma.waitlistEntry.create({ data: { clientId: gaveItUp.id } });

    const slots = await freedSlots(actor(desk), { clock: FRIDAY_BEFORE });
    expect(slots[0]!.candidates.map((c) => c.client.code)).toEqual(['TC-FIRST', 'TC-SECOND']);
  });

  it('shows the opening even when nobody on the list can take it', async () => {
    await cancelledSession(900);
    const slots = await freedSlots(actor(desk), { clock: FRIDAY_BEFORE });
    expect(slots).toHaveLength(1);
    expect(slots[0]!.candidates).toEqual([]);
  });

  it('books nothing', async () => {
    const { client: gaveItUp } = await cancelledSession(900);
    const waiting = await makeClient(therapist.id);
    await prisma.waitlistEntry.create({ data: { clientId: waiting.id } });

    await freedSlots(actor(desk), { clock: FRIDAY_BEFORE });
    expect(await prisma.appointment.count({ where: { status: { in: ['scheduled', 'confirmed'] } } })).toBe(0);
    expect(await prisma.appointment.count({ where: { clientId: waiting.id } })).toBe(0);
    expect(await prisma.appointment.count({ where: { clientId: gaveItUp.id } })).toBe(1);
  });

  /** A therapist sees the hours that are theirs to fill, and no others. */
  it('shows a therapist only their own freed hours', async () => {
    const other = await makeUser('therapist');
    await prisma.availability.create({ data: { userId: other.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
    const theirClient = await makeClient(other.id);
    const theirAppt = await bookAppointment(actor(desk), {
      clientId: theirClient.id, clinicianId: other.id, date: '2026-09-01',
      startMinute: 780, type: 'standard', modality: 'in_person',
    });
    await cancelAppointment(actor(desk), theirAppt.id, { clock: FRIDAY_BEFORE });
    await cancelledSession(900);

    expect(await freedSlots(actor(desk), { clock: FRIDAY_BEFORE })).toHaveLength(2);
    const mine = await freedSlots(actor(therapist), { clock: FRIDAY_BEFORE });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.startMinute).toBe(900);
  });

  it('stays inside the horizon it was asked for', async () => {
    await cancelledSession();
    expect(await freedSlots(actor(desk), { clock: FRIDAY_BEFORE, horizonDays: 1 })).toEqual([]);
    expect(await freedSlots(actor(desk), { clock: FRIDAY_BEFORE, horizonDays: 30 })).toHaveLength(1);
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
    // The fee needs a carrier to have said the message arrived, so the fixture
    // takes that road too. Without it every `silent` session would be exempted
    // as undelivered, which is right, and would quietly make this report a
    // report about nothing.
    await deliverOutbox(new Date(START.getTime() - 2 * DAY + HOUR));

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

  /**
   * P2. The delivery rate sits beside the charge rate because it is now the
   * charge's precondition. A practice looking at "we charged four people" needs
   * to see "and eleven reminders never arrived" without changing pages — the
   * second number is why the first one is what it is.
   */
  it('reports what the carrier did with the reminders it was given', async () => {
    await session(9 * 60, 'confirmed');
    await session(10 * 60, 'silent');

    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.messages.delivered).toBeGreaterThan(0);
    expect(report.messages.failed).toBe(0);
    expect(report.messages.deliveredRate).toBe(1);
  });

  it('counts an undelivered reminder, and drops the rate for it', async () => {
    await session(9 * 60, 'confirmed');
    await prisma.outboxMessage.updateMany({
      where: { templateKey: 'appointment_reminder' },
      data: { deliveryState: 'failed', failureCode: 'unreachable', deliveredAt: null },
    });

    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.messages.delivered).toBe(0);
    expect(report.messages.failed).toBeGreaterThan(0);
    expect(report.messages.deliveredRate).toBe(0);
  });

  /**
   * `sent` is a carrier saying it took the message. It is not evidence that
   * anybody received it, so it is counted apart from `delivered` rather than
   * folded in — which is the same distinction the fee rule makes.
   */
  it('keeps messages awaiting a receipt out of the delivered count', async () => {
    await session(9 * 60, 'confirmed');
    await prisma.outboxMessage.updateMany({
      where: { templateKey: 'appointment_reminder' },
      data: { deliveryState: 'sent', deliveredAt: null },
    });

    const report = await confirmationReport(actor(admin), RANGE);
    expect(report.messages.delivered).toBe(0);
    expect(report.messages.awaiting).toBeGreaterThan(0);
    expect(report.messages.deliveredRate).toBe(0);
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
    await deliverOutbox(new Date(START.getTime() - 2 * HOUR));
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

/**
 * P2. The list that exists because of what the delivery precondition does not
 * do: it stops the fee, silently, and a practice that only stopped charging
 * would also have stopped noticing.
 */
describe('the clients nobody could reach', () => {
  const START = new Date('2026-09-01T19:00:00Z');
  const clock = fixedClock(START);
  let desk: Awaited<ReturnType<typeof makeUser>>;
  let therapist: Awaited<ReturnType<typeof makeUser>>;
  let other: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
    other = await makeUser('therapist');
  });

  /** A client with one message in whatever delivery state the test needs. */
  async function messaged(
    state: 'failed' | 'delivered',
    opts: { failureCode?: 'unreachable' | 'expired'; at?: Date; clinicianId?: string } = {},
  ) {
    const client = await makeClient(opts.clinicianId ?? therapist.id);
    await prisma.client.update({
      where: { id: client.id }, data: { email: 'tc@example.test', phone: '555-010-0100' },
    });
    const at = opts.at ?? new Date(START.getTime() - DAY);
    await prisma.outboxMessage.create({
      data: {
        clientId: client.id, channel: 'email', templateKey: 'appointment_reminder',
        subject: 'Appointment reminder', body: 'Appointment reminder: Tuesday 15:00, Stillwater.',
        scheduledFor: at, deliveryState: state, decidedAt: at, attempts: 1,
        ...(state === 'failed'
          ? { failureCode: opts.failureCode ?? 'unreachable' }
          : { deliveredAt: at, sentAt: at }),
      },
    });
    return client;
  }

  it('lists a client whose message permanently failed, with the number to ring', async () => {
    const client = await messaged('failed');
    const list = await unreachableClients(actor(desk), { clock });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ failureCode: 'unreachable', failures: 1 });
    expect(list[0]!.client.phone).toBe('555-010-0100');
  });

  it('says nothing about a client whose messages arrive', async () => {
    await messaged('delivered');
    expect(await unreachableClients(actor(desk), { clock })).toEqual([]);
  });

  /**
   * `expired` is the practice running out of time, not the client being
   * unreachable — the message was abandoned because its hour started, which
   * says nothing about the number. Sending front desk to ring those people
   * would make the list not worth reading, which is how a work-list dies.
   */
  it('does not ring a client whose message was merely abandoned', async () => {
    await messaged('failed', { failureCode: 'expired' });
    expect(await unreachableClients(actor(desk), { clock })).toEqual([]);
  });

  /** A corrected number takes the client off the list without anybody marking it. */
  it('clears a client once something reaches them again', async () => {
    const client = await messaged('failed', { at: new Date(START.getTime() - 2 * DAY) });
    expect(await unreachableClients(actor(desk), { clock })).toHaveLength(1);

    await prisma.outboxMessage.create({
      data: {
        clientId: client.id, channel: 'email', templateKey: 'appointment_reminder',
        subject: 'Appointment reminder', body: 'Appointment reminder: Wednesday 15:00, Stillwater.',
        scheduledFor: new Date(START.getTime() - DAY), deliveryState: 'delivered',
        sentAt: new Date(START.getTime() - DAY), deliveredAt: new Date(START.getTime() - DAY),
        decidedAt: new Date(START.getTime() - DAY), attempts: 1,
      },
    });
    expect(await unreachableClients(actor(desk), { clock })).toEqual([]);
  });

  it('does not clear a client whose last delivery predates the failure', async () => {
    const client = await messaged('failed');
    await prisma.outboxMessage.create({
      data: {
        clientId: client.id, channel: 'email', templateKey: 'appointment_reminder',
        subject: 'Appointment reminder', body: 'Appointment reminder: Monday 15:00, Stillwater.',
        scheduledFor: new Date(START.getTime() - 3 * DAY), deliveryState: 'delivered',
        sentAt: new Date(START.getTime() - 3 * DAY), deliveredAt: new Date(START.getTime() - 3 * DAY),
        decidedAt: new Date(START.getTime() - 3 * DAY), attempts: 1,
      },
    });
    expect(await unreachableClients(actor(desk), { clock })).toHaveLength(1);
  });

  it('counts repeated failures for one client as one call to make', async () => {
    const client = await messaged('failed');
    for (const days of [2, 3]) {
      await prisma.outboxMessage.create({
        data: {
          clientId: client.id, channel: 'email', templateKey: 'appointment_reminder',
          subject: 'Appointment reminder', body: 'Appointment reminder: Tuesday 15:00, Stillwater.',
          scheduledFor: new Date(START.getTime() - days * DAY), deliveryState: 'failed',
          failureCode: 'unreachable', decidedAt: new Date(START.getTime() - days * DAY), attempts: 1,
        },
      });
    }
    const list = await unreachableClients(actor(desk), { clock });
    expect(list).toHaveLength(1);
    expect(list[0]!.failures).toBe(3);
  });

  it('forgets a failure older than the window', async () => {
    await messaged('failed', { at: new Date(START.getTime() - 90 * DAY) });
    expect(await unreachableClients(actor(desk), { clock })).toEqual([]);
  });

  it('leaves an inactive client off it — nobody is booking them', async () => {
    const client = await messaged('failed');
    await prisma.client.update({ where: { id: client.id }, data: { status: 'inactive' } });
    expect(await unreachableClients(actor(desk), { clock })).toEqual([]);
  });

  it('shows a clinician their own caseload and nobody else\'s', async () => {
    await messaged('failed', { clinicianId: other.id });
    expect(await unreachableClients(actor(therapist), { clock })).toEqual([]);
    expect(await unreachableClients(actor(other), { clock })).toHaveLength(1);
    // Front desk rings people, so front desk sees all of them.
    expect(await unreachableClients(actor(desk), { clock })).toHaveLength(1);
  });

  /**
   * The list carries a name, a number and a failure code — everything needed to
   * ring somebody — and no message content at all. A work-list built from the
   * outbox is one careless `select` away from putting bodies on a front-desk
   * screen, which is the leak this whole feature is arranged around.
   */
  it('carries no message content anywhere in it', async () => {
    await messaged('failed');
    const text = JSON.stringify(await unreachableClients(actor(desk), { clock }));
    for (const term of ['Appointment reminder: Tuesday 15:00', 'Stillwater', 'subject', 'body']) {
      expect(text).not.toContain(term);
    }
  });
});


/**
 * P16. Charges the record no longer supports.
 *
 * Every precondition on the fee is asked once, before the money, by a job that
 * reads only `pending` — so a correction arriving afterwards is invisible to it,
 * and that is the realistic case rather than the exotic one: the client rings
 * about a ninety-dollar fee, and in that conversation it emerges the practice
 * has had them down in the wrong language since intake. The sweep produced the
 * call and will never revisit its own answer.
 */
describe('the charges a correction leaves standing', () => {
  const START = new Date('2026-09-01T19:00:00Z');
  const clock = fixedClock(START);
  let desk: Awaited<ReturnType<typeof makeUser>>;
  let therapist: Awaited<ReturnType<typeof makeUser>>;
  let other: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
    other = await makeUser('therapist');
  });

  /**
   * A session charged for silence, with its reminders written in `renderedIn`.
   *
   * Built directly rather than driven through the cadence, because what this
   * list reads is a *finished* row — the sweep has already run, the money has
   * already landed, and the correction is what happens next. Driving the cadence
   * would test the cadence.
   */
  async function charged(opts: {
    renderedIn: ('en' | 'es' | null)[];
    reads?: 'en' | 'es';
    /** Indices of `renderedIn` a carrier never delivered. */
    failed?: number[];
    clinicianId?: string;
    status?: 'no_show' | 'completed';
    waived?: boolean;
    startAt?: Date;
  }) {
    const clinicianId = opts.clinicianId ?? therapist.id;
    const client = await makeClient(clinicianId);
    await prisma.client.update({
      where: { id: client.id },
      data: { email: 'tc@example.test', language: opts.reads ?? 'es' },
    });
    const startAt = opts.startAt ?? new Date(START.getTime() - 2 * DAY);
    const appt = await prisma.appointment.create({
      data: {
        clientId: client.id, clinicianId, startAt,
        endAt: new Date(startAt.getTime() + 50 * 60_000),
        modality: 'telehealth',
        createdAt: new Date(startAt.getTime() - 30 * DAY),
        bookedAt: new Date(startAt.getTime() - 30 * DAY),
        status: opts.status ?? 'no_show',
        confirmation: 'no_response',
        chargeFeeCents: 9000,
        ...(opts.waived
          ? { feeWaivedAt: START, feeWaiveReason: 'practice_error', feeWaivedById: desk.id }
          : {}),
      },
    });

    const stages = ['d5', 'd1', 'd0'] as const;
    for (const [i, language] of opts.renderedIn.entries()) {
      const message = await prisma.outboxMessage.create({
        data: {
          clientId: client.id, channel: 'email', templateKey: 'appointment_reminder',
          subject: 'Appointment reminder', body: 'Appointment reminder: Tuesday 15:00.',
          scheduledFor: startAt, language,
          deliveryState: opts.failed?.includes(i) ? 'failed' : 'delivered',
          ...(opts.failed?.includes(i)
            ? { failureCode: 'unreachable', decidedAt: startAt }
            : { deliveredAt: startAt, sentAt: startAt, decidedAt: startAt }),
        },
      });
      await prisma.appointmentReminder.create({
        data: {
          appointmentId: appt.id, stage: stages[i]!,
          dueAt: new Date(startAt.getTime() - (3 - i) * DAY),
          sentAt: startAt, outboxMessageId: message.id,
        },
      });
    }
    return { client, appt };
  }

  it('names a charge whose messages were all in the language the record used to say', async () => {
    const { client } = await charged({ renderedIn: ['en', 'en', 'en'], reads: 'es' });

    const { fees, uncheckable } = await unsupportedFees(actor(desk), { clock });
    expect(uncheckable).toBe(0);
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({
      chargeFeeCents: 9000, renderedIn: ['en'], readsIn: 'es',
    });
    expect(fees[0]!.client.id).toBe(client.id);
  });

  it('leaves a charge alone where one delivered message was readable', async () => {
    await charged({ renderedIn: ['en', 'es'], reads: 'es' });
    expect((await unsupportedFees(actor(desk), { clock })).fees).toEqual([]);
  });

  /**
   * The narrowing the sweep already does, applied to the same question asked
   * afterwards.
   *
   * A client corrected mid-cadence: two English reminders delivered, and the one
   * Spanish reminder the corrected record produced never arrived. A message that
   * did not arrive is not evidence the charge rested on, so it does not rescue
   * the fee — this is the case the previous phase's `legible` filter exists for,
   * read back from the other end.
   */
  it('does not count a readable message that never arrived', async () => {
    await charged({ renderedIn: ['en', 'en', 'es'], failed: [2], reads: 'es' });

    const { fees } = await unsupportedFees(actor(desk), { clock });
    expect(fees).toHaveLength(1);
    // And the row says what was actually read, not what was attempted.
    expect(fees[0]!.renderedIn).toEqual(['en']);
  });

  /**
   * The third answer, and the reason this is not a boolean. Rows from before
   * `OutboxMessage.language` existed cannot be checked either way. Calling them
   * unsupported would turn every historical fee into an accusation nothing can
   * back; calling them supported would be the assumption the phase refuses.
   */
  it('counts a charge it cannot check, and does not name it', async () => {
    await charged({ renderedIn: [null, null], reads: 'es' });
    const { fees, uncheckable } = await unsupportedFees(actor(desk), { clock });
    expect(fees).toEqual([]);
    expect(uncheckable).toBe(1);
  });

  it('names the mixed case, because nothing in it is known to be readable', async () => {
    await charged({ renderedIn: ['en', null], reads: 'es' });
    const { fees, uncheckable } = await unsupportedFees(actor(desk), { clock });
    expect(fees).toHaveLength(1);
    expect(uncheckable).toBe(0);
  });

  /**
   * A client who never answered and then walked in pays the ordinary session
   * fee, which rests on their having come rather than on anything they read. A
   * correction does not touch it, and a list that named it would be sending
   * somebody to reverse a charge for a session that happened.
   */
  it('ignores a session the client attended, whatever language it was asked in', async () => {
    await charged({ renderedIn: ['en'], reads: 'es', status: 'completed' });
    const { fees, uncheckable } = await unsupportedFees(actor(desk), { clock });
    expect(fees).toEqual([]);
    expect(uncheckable).toBe(0);
  });

  /** Already stood down by a person. Listing it sends somebody to fix what is fixed. */
  it('drops a fee somebody has already waived', async () => {
    await charged({ renderedIn: ['en'], reads: 'es', waived: true });
    expect((await unsupportedFees(actor(desk), { clock })).fees).toEqual([]);
  });

  /**
   * Derived, so correcting the record back clears the row without anybody
   * marking anything handled — the same property `unreachableClients` has, and
   * for the same reason: a list that has to be tidied gets tidied instead of
   * worked.
   */
  it('clears itself when the record is corrected back', async () => {
    const { client } = await charged({ renderedIn: ['en'], reads: 'es' });
    expect((await unsupportedFees(actor(desk), { clock })).fees).toHaveLength(1);

    await prisma.client.update({ where: { id: client.id }, data: { language: 'en' } });
    expect((await unsupportedFees(actor(desk), { clock })).fees).toEqual([]);
  });

  it('writes nothing at all — it reverses no fee and marks nothing handled', async () => {
    const { appt } = await charged({ renderedIn: ['en'], reads: 'es' });
    await unsupportedFees(actor(desk), { clock });

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.chargeFeeCents).toBe(9000);
    expect(after.feeWaivedAt).toBeNull();
    expect(after.confirmation).toBe('no_response');
  });

  it('shows a clinician their own caseload and nobody else’s', async () => {
    await charged({ renderedIn: ['en'], reads: 'es', clinicianId: other.id });

    expect((await unsupportedFees(actor(therapist), { clock })).fees).toEqual([]);
    expect((await unsupportedFees(actor(other), { clock })).fees).toHaveLength(1);
    // Front desk and the practice manager handle the money, so they see all.
    expect((await unsupportedFees(actor(desk), { clock })).fees).toHaveLength(1);
  });

  it('is refused to a role with no claim on a fee', async () => {
    for (const role of ROLES.filter((r) => r === 'auditor' || r === 'client')) {
      const who = await makeUser(role);
      await expect(unsupportedFees(actor(who), { clock })).rejects.toBeInstanceOf(Forbidden);
    }
  });

  /**
   * The same rule every work-list built on the outbox meets. This one is one
   * careless `select` from putting a reminder body on a front-desk screen, and
   * the finding needs the *language* rather than the words.
   */
  it('carries no message content anywhere in it', async () => {
    await charged({ renderedIn: ['en'], reads: 'es' });
    const text = JSON.stringify(await unsupportedFees(actor(desk), { clock }));
    for (const term of ['Appointment reminder: Tuesday 15:00', 'subject', 'body']) {
      expect(text).not.toContain(term);
    }
  });
});
