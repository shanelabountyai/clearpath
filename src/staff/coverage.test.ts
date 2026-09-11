import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { can, type Role } from '../auth/permissions';
import { clinicianCapacity } from '../clients/inquiry';
import { clientTarget, getClient, listClients } from '../clients/repository';
import { fixedClock, type Clock } from '../clock';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { wellbeingCheckIn } from '../forms/fixtures';
import { issueForm, publishTemplate, submitForm } from '../forms/service';
import { receiveInbound } from '../messaging/inbound';
import { listProgressNotes } from '../notes/service';
import { actor, makeClient, makeUser, resetDb, settings } from '../test/harness';
import { zonedToUtc, type LocalDate } from '../time';
import { alertRecipient } from './coverage';
import { departureBlockers, executeDeparture, planDeparture } from './departure';
import { cancelLeave, createLeave, decideCoverage, editLeaveDates, nameCoverer, runLeaveAlertSweep } from './leave-plan';

/** Midday in the practice's zone, so no test sits on a midnight it did not mean to. */
const on = (d: LocalDate) => fixedClock(zonedToUtc(d, 12 * 60));
const RECORDED = on('2026-09-11');
const NOUR_AWAY = { fromDate: '2026-10-05', toDate: '2026-11-27' };
const DAY_BEFORE = on('2026-10-04');
const FIRST = on('2026-10-05');
const DAY_TWO = on('2026-10-06');
const LAST = on('2026-11-27');
const BACK = on('2026-11-28');

beforeEach(async () => {
  await resetDb();
  await settings({ messagingName: 'Stillwater' });
});
afterAll(() => prisma.$disconnect());

/** Nour away with Dev covering; Sam has split one client to Kai (story 2). */
async function onLeave() {
  const ray = await makeUser('admin');
  const sam = await makeUser('supervisor');
  const nour = await makeUser('therapist', { supervisorId: sam.id });
  const dev = await makeUser('therapist');
  const kai = await makeUser('therapist');
  const desk = await makeUser('front_desk');
  const mine = await makeClient(nour.id);
  const split = await makeClient(nour.id);
  const leave = await createLeave(
    actor(ray), { userId: nour.id, ...NOUR_AWAY, coveringClinicianId: dev.id }, RECORDED,
  );
  await decideCoverage(actor(sam), leave.id, { clientId: split.id, coveringClinicianId: kai.id }, RECORDED);
  return { ray, sam, nour, dev, kai, desk, mine, split, leave };
}

// ─────────────────────────── resolution ───────────────────────────

describe('which leave and which coverer (clientTarget)', () => {
  it('a per-client row naming Kai beats the leave-level coverer', async () => {
    const p = await onLeave();

    const split = await clientTarget(p.split.id, DAY_TWO);
    expect(split.coverage).toMatchObject({ leaveId: p.leave.id, coveringClinicianId: p.kai.id });
    expect(can(actor(p.kai), 'read', 'client', split)).toMatchObject({ allowed: true, coveringLeaveId: p.leave.id });
    expect(can(actor(p.dev), 'read', 'client', split).allowed).toBe(false);

    const mine = await clientTarget(p.mine.id, DAY_TWO);
    expect(mine.coverage?.coveringClinicianId).toBe(p.dev.id);
  });

  it('opens the record on both boundary days and neither side, and each read names the leave', async () => {
    const p = await onLeave();
    for (const day of [FIRST, LAST]) await expect(getClient(actor(p.dev), p.mine.id, day)).resolves.toBeTruthy();
    for (const day of [DAY_BEFORE, BACK]) {
      await expect(getClient(actor(p.dev), p.mine.id, day)).rejects.toBeInstanceOf(Forbidden);
    }

    const reads = await prisma.auditEvent.findMany({ where: { actorId: p.dev.id, resource: 'client' }, orderBy: { at: 'asc' } });
    expect(reads.map((r) => [r.allowed, r.reason])).toEqual([
      [true, `leave:${p.leave.id}`], [true, `leave:${p.leave.id}`], [false, null], [false, null],
    ]);
  });

  it('never attributes the treating clinician\'s own read to the leave', async () => {
    const p = await onLeave();
    await getClient(actor(p.nour), p.mine.id, DAY_TWO);
    const [row] = await prisma.auditEvent.findMany({ where: { actorId: p.nour.id, resource: 'client' } });
    expect(row).toMatchObject({ allowed: true, reason: null });
  });

  it('stops the day after an early return, and a cancelled leave resolves to nothing', async () => {
    const p = await onLeave();
    await editLeaveDates(actor(p.ray), p.leave.id, { fromDate: NOUR_AWAY.fromDate, toDate: '2026-10-20' }, DAY_TWO);
    await expect(getClient(actor(p.dev), p.mine.id, on('2026-10-20'))).resolves.toBeTruthy();
    await expect(getClient(actor(p.dev), p.mine.id, on('2026-10-21'))).rejects.toBeInstanceOf(Forbidden);

    const winter = await createLeave(
      actor(p.ray), { userId: p.nour.id, fromDate: '2026-12-14', toDate: '2026-12-18', coveringClinicianId: p.dev.id }, DAY_TWO,
    );
    await cancelLeave(actor(p.ray), winter.id, DAY_TWO);
    expect((await clientTarget(p.mine.id, on('2026-12-15'))).coverage).toBeUndefined();
  });
});

describe('the caseload list (caseloadWhere)', () => {
  const ids = async (who: { id: string; role: Role }, clock: Clock, search?: string) =>
    (await listClients(actor(who), { clock, search })).map((c) => c.id).sort();

  it('lists what each person covers today, and nothing either side of the window', async () => {
    const p = await onLeave();
    expect(await ids(p.dev, DAY_TWO)).toEqual([p.mine.id]);
    expect(await ids(p.kai, DAY_TWO)).toEqual([p.split.id]);
    expect(await ids(p.nour, DAY_TWO)).toEqual([p.mine.id, p.split.id].sort());
    expect(await ids(p.dev, DAY_BEFORE)).toEqual([]);
    expect(await ids(p.dev, BACK)).toEqual([]);
  });

  it('marks what a person covers with the leave\'s last day, and nothing else (P1-2)', async () => {
    const p = await onLeave();
    const marks = async (who: { id: string; role: Role }) =>
      (await listClients(actor(who), { clock: DAY_TWO })).map((c) => [c.id, c.coveringUntil]);
    expect(await marks(p.dev)).toEqual([[p.mine.id, NOUR_AWAY.toDate]]);
    expect(await marks(p.nour)).toEqual(expect.arrayContaining([[p.mine.id, null], [p.split.id, null]]));
    expect((await marks(p.desk)).every(([, until]) => until === null)).toBe(true);
    // Sam reads these rows as Nour's supervisor, not as the one covering them.
    expect((await marks(p.sam)).every(([, until]) => until === null)).toBe(true);
  });

  it('keeps the scope when a search brings its own OR', async () => {
    const p = await onLeave();
    expect(await ids(p.dev, DAY_TWO, 'Test')).toEqual([p.mine.id]);
  });
});

describe('progress notes on a covered client', () => {
  it('the coverer lists the whole record for the window; break-glass still lists only its own', async () => {
    const p = await onLeave();
    const appt = await prisma.appointment.create({
      data: { clientId: p.mine.id, clinicianId: p.nour.id, modality: 'telehealth', startAt: zonedToUtc('2026-09-29', 600), endAt: zonedToUtc('2026-09-29', 650) },
    });
    await prisma.progressNote.create({ data: { appointmentId: appt.id, clientId: p.mine.id, authorId: p.nour.id, content: 'synthetic' } });

    expect(await listProgressNotes(actor(p.dev), p.mine.id, DAY_TWO)).toHaveLength(1);
    expect(await listProgressNotes(actor(p.dev), p.mine.id, BACK)).toHaveLength(0);
    expect(await listProgressNotes(actor(p.ray, 'client in crisis'), p.mine.id, DAY_TWO)).toHaveLength(0);

    const [covered] = await prisma.auditEvent.findMany({ where: { actorId: p.dev.id, resource: 'progress_note' }, orderBy: { at: 'asc' } });
    expect(covered?.reason).toBe(`leave:${p.leave.id}`);
  });
});

// ───────────────────────────── alerts ─────────────────────────────

describe('one reader per alert (P0-5)', () => {
  it('routes to the coverer on the window\'s days, honouring the split, and to Nour otherwise', async () => {
    const p = await onLeave();
    expect(await alertRecipient(prisma, p.mine.id, '2026-10-06')).toEqual({ recipientId: p.dev.id, coveringLeaveId: p.leave.id });
    expect(await alertRecipient(prisma, p.split.id, '2026-10-06')).toEqual({ recipientId: p.kai.id, coveringLeaveId: p.leave.id });
    expect(await alertRecipient(prisma, p.mine.id, '2026-10-04')).toEqual({ recipientId: p.nour.id, coveringLeaveId: null });
    expect(await alertRecipient(prisma, p.mine.id, '2026-11-28')).toEqual({ recipientId: p.nour.id, coveringLeaveId: null });
  });

  it('a critical screener on day two raises one alert, to the coverer; the day after, to Nour', async () => {
    const p = await onLeave();
    await publishTemplate(actor(p.ray), { key: 'wellbeing-check-in', name: 'Wellbeing Check-In', kind: 'screener', ...wellbeingCheckIn });
    const critical = { ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`item_${i + 1}`, 0])), item_9: 2 };

    const during = await issueForm(actor(p.desk), { clientId: p.mine.id, templateKey: 'wellbeing-check-in', clock: DAY_TWO });
    await submitForm(during.token, critical, { clock: DAY_TWO });
    const after = await issueForm(actor(p.desk), { clientId: p.mine.id, templateKey: 'wellbeing-check-in', clock: BACK });
    await submitForm(after.token, critical, { clock: BACK });

    const alerts = await prisma.alert.findMany({ orderBy: { createdAt: 'asc' } });
    expect(alerts.map((a) => [a.recipientId, a.coveringLeaveId, a.kind])).toEqual([
      [p.dev.id, p.leave.id, 'screener_critical_item'],
      [p.nour.id, null, 'screener_critical_item'],
    ]);
  });

  it('an unparsed text on day three reaches the coverer', async () => {
    const p = await onLeave();
    await prisma.client.update({ where: { id: p.mine.id }, data: { phone: '555-0142' } });
    await receiveInbound({ from: '555-0142', body: 'can we talk' }, { clock: on('2026-10-07') });
    expect(await prisma.alert.findMany()).toMatchObject([
      { recipientId: p.dev.id, coveringLeaveId: p.leave.id, kind: 'inbound_unparsed' },
    ]);
  });
});

describe('the boundary sweep', () => {
  it('moves unread alerts at both boundaries and after a new decision, never an acknowledged one, and is idempotent', async () => {
    const p = await onLeave();
    const raise = (clientId: string, over: { acknowledgedAt?: Date } = {}) =>
      prisma.alert.create({ data: { recipientId: p.nour.id, clientId, kind: 'inbound_unparsed', ...over } });
    const at = (id: string) => prisma.alert.findUniqueOrThrow({ where: { id } });
    const unread = await raise(p.mine.id);
    const unreadSplit = await raise(p.split.id);
    const seen = await raise(p.mine.id, { acknowledgedAt: zonedToUtc('2026-10-01', 600) });

    expect(await runLeaveAlertSweep(DAY_BEFORE)).toEqual([]);
    expect((await runLeaveAlertSweep(FIRST)).sort()).toEqual([unread.id, unreadSplit.id].sort());
    expect(await runLeaveAlertSweep(FIRST)).toEqual([]);
    expect(await at(unread.id)).toMatchObject({ recipientId: p.dev.id, coveringLeaveId: p.leave.id });
    expect(await at(unreadSplit.id)).toMatchObject({ recipientId: p.kai.id, coveringLeaveId: p.leave.id });
    expect(await at(seen.id)).toMatchObject({ recipientId: p.nour.id, coveringLeaveId: null });

    // Sam hands the split client back to the leave's coverer; the unread alert
    // follows in that write (D-19), so the sweep finds nothing left to do.
    await decideCoverage(actor(p.sam), p.leave.id, { clientId: p.split.id, coveringClinicianId: p.dev.id }, DAY_TWO);
    expect(await at(unreadSplit.id)).toMatchObject({ recipientId: p.dev.id });
    expect(await runLeaveAlertSweep(DAY_TWO)).toEqual([]);

    // Dev reads one in the window. "Dev saw this on 14 October" stays true.
    await prisma.alert.update({ where: { id: unread.id }, data: { acknowledgedAt: zonedToUtc('2026-10-14', 600) } });
    expect(await runLeaveAlertSweep(LAST)).toEqual([]);
    expect(await runLeaveAlertSweep(BACK)).toEqual([unreadSplit.id]);
    expect(await runLeaveAlertSweep(BACK)).toEqual([]);
    expect(await at(unread.id)).toMatchObject({ recipientId: p.dev.id, coveringLeaveId: p.leave.id });
    expect(await at(unreadSplit.id)).toMatchObject({ recipientId: p.nour.id, coveringLeaveId: null });

    const moves = await prisma.auditEvent.findMany({ where: { reason: { startsWith: 'leave:alert_' } }, orderBy: { at: 'asc' } });
    expect(moves.map((m) => [m.actorId, m.resource, m.resourceId, m.clientId, m.reason])).toEqual([
      ...[p.mine.id, p.split.id].map((c) => ['system', 'leave', p.leave.id, c, 'leave:alert_to_coverer']).sort(),
      [p.sam.id, 'leave', p.leave.id, p.split.id, 'leave:alert_to_coverer'],
      ['system', 'leave', p.leave.id, p.split.id, 'leave:alert_returned'],
    ]);
  });
});

describe('a write that changes today\'s reader moves the alerts itself (D-19)', () => {
  it('a leave recorded to start today takes the unread alerts in its own transaction', async () => {
    const ray = await makeUser('admin');
    const nour = await makeUser('therapist');
    const dev = await makeUser('therapist');
    const client = await makeClient(nour.id);
    const unread = await prisma.alert.create({ data: { recipientId: nour.id, clientId: client.id, kind: 'inbound_unparsed' } });

    const leave = await createLeave(actor(ray), { userId: nour.id, ...NOUR_AWAY, coveringClinicianId: dev.id }, FIRST);

    expect(await prisma.alert.findUniqueOrThrow({ where: { id: unread.id } }))
      .toMatchObject({ recipientId: dev.id, coveringLeaveId: leave.id });
    expect(await prisma.auditEvent.findFirst({ where: { reason: 'leave:alert_to_coverer' } })).toMatchObject({ actorId: ray.id });
    expect(await runLeaveAlertSweep(FIRST)).toEqual([]);
  });

  it('a new coverer named mid-leave is handed the unread alerts the old one held', async () => {
    const p = await onLeave();
    const unread = await prisma.alert.create({
      data: { recipientId: p.dev.id, clientId: p.mine.id, kind: 'inbound_unparsed', coveringLeaveId: p.leave.id },
    });
    const sub = await makeUser('therapist');

    await nameCoverer(actor(p.ray), p.leave.id, sub.id, DAY_TWO);

    expect(await prisma.alert.findUniqueOrThrow({ where: { id: unread.id } }))
      .toMatchObject({ recipientId: sub.id, coveringLeaveId: p.leave.id });
  });
});

describe('back today (D-18)', () => {
  it('the edit ends the coverer\'s reads and returns the leave\'s unread alerts in its own transaction', async () => {
    const p = await onLeave();
    const covered = { clientId: p.mine.id, kind: 'inbound_unparsed' as const, recipientId: p.dev.id, coveringLeaveId: p.leave.id };
    const unread = await prisma.alert.create({ data: covered });
    const seen = await prisma.alert.create({ data: { ...covered, acknowledgedAt: zonedToUtc('2026-10-14', 600) } });
    const back = on('2026-10-20');

    await editLeaveDates(actor(p.ray), p.leave.id, { fromDate: NOUR_AWAY.fromDate, toDate: '2026-10-19' }, back);

    await expect(getClient(actor(p.dev), p.mine.id, back)).rejects.toBeInstanceOf(Forbidden);
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: unread.id } })).toMatchObject({ recipientId: p.nour.id, coveringLeaveId: null });
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: seen.id } })).toMatchObject({ recipientId: p.dev.id, coveringLeaveId: p.leave.id });
    expect(await prisma.auditEvent.findFirst({ where: { reason: 'leave:alert_returned' } }))
      .toMatchObject({ actorId: p.ray.id, resourceId: p.leave.id, clientId: p.mine.id });
    expect(await runLeaveAlertSweep(back)).toEqual([]);
  });
});

// ─────────────────────── capacity and departure ───────────────────────

describe('the books close for the window (P0-6)', () => {
  it('front desk reads Nour closed on the leave\'s days, and Nour\'s declared value never changes', async () => {
    const p = await onLeave();
    const nour = async (clock: Clock) => (await clinicianCapacity(actor(p.desk), clock)).find((c) => c.id === p.nour.id);
    expect(await nour(DAY_BEFORE)).toMatchObject({ accepting: true, declared: true });
    expect(await nour(FIRST)).toMatchObject({ accepting: false, declared: true });
    expect(await nour(LAST)).toMatchObject({ accepting: false, declared: true });
    expect(await nour(BACK)).toMatchObject({ accepting: true, declared: true });
  });
});

describe('a departure over an open leave (P0-8)', () => {
  it('is a blocker while the leave has not ended, and execution refuses with leave_open', async () => {
    const p = await onLeave();
    const d = await planDeparture(actor(p.ray), { userId: p.nour.id, lastDayOn: '2026-10-20' }, RECORDED);

    expect(await departureBlockers(actor(p.ray), d.id, DAY_TWO)).toContainEqual({ kind: 'leave_open', leaveId: p.leave.id });
    await expect(executeDeparture(actor(p.ray), d.id, on('2026-10-20'))).rejects.toMatchObject({ code: 'leave_open' });
    expect((await departureBlockers(actor(p.ray), d.id, BACK)).map((b) => b.kind)).not.toContain('leave_open');
  });
});
