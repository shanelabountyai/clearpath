import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { wellbeingCheckIn } from '../forms/fixtures';
import { issueForm, publishTemplate, submitForm } from '../forms/service';
import { actor, makeClient, makeUser, resetDb, settings } from '../test/harness';
import { localDateOf, zonedToUtc, type LocalDate } from '../time';
import {
  cancelLeave, createLeave, decideCoverage, editLeaveDates, getLeavePlan, leaveWorklist, listLeaves, nameCoverer, nameSupervisionCover,
  runLeaveAlertSweep, uncoveredAbsenceAlerts, whileYouWereAway,
} from './leave-plan';

/** Midday in the practice's zone, so no test sits on a midnight it did not mean to. */
const on = (d: LocalDate) => fixedClock(zonedToUtc(d, 12 * 60));
const RECORDED = on('2026-09-11');
const dbDate = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const NOUR_AWAY = { fromDate: '2026-10-05', toDate: '2026-11-27' };

beforeEach(async () => {
  await resetDb();
  await settings();
});
afterAll(() => prisma.$disconnect());

/** Ray runs the practice, Sam supervises Nour, Dev and Kai could each cover. */
async function practice() {
  const ray = await makeUser('admin');
  const sam = await makeUser('supervisor');
  const nour = await makeUser('therapist', { supervisorId: sam.id });
  const dev = await makeUser('therapist');
  const kai = await makeUser('therapist');
  const client = await makeClient(nour.id);
  return { ray, sam, nour, dev, kai, client };
}

async function onLeave() {
  const p = await practice();
  const leave = await createLeave(
    actor(p.ray), { userId: p.nour.id, ...NOUR_AWAY, coveringClinicianId: p.dev.id }, RECORDED,
  );
  return { ...p, leave };
}

const leaveAudit = () =>
  prisma.auditEvent.findMany({ where: { resource: 'leave' }, orderBy: { at: 'asc' } });

// ─────────────────── what the database refuses ───────────────────

describe('the leave row, against a real connection (P0-1, P0-7)', () => {
  type People = Awaited<ReturnType<typeof practice>>;

  /** A raw row with its calendar row, bypassing the service. */
  async function row(p: People, over: { userId?: string; fromDate?: LocalDate; toDate?: LocalDate } & Record<string, unknown> = {}) {
    const { userId = p.nour.id, fromDate = NOUR_AWAY.fromDate, toDate = NOUR_AWAY.toDate, ...rest } = over;
    const override = await prisma.availabilityOverride.create({
      data: { userId, fromDate: dbDate(fromDate), toDate: dbDate(toDate) },
    });
    return prisma.leave.create({
      data: {
        userId, fromDate: dbDate(fromDate), toDate: dbDate(toDate),
        coveringClinicianId: p.dev.id, plannedById: p.ray.id, overrideId: override.id, ...rest,
      },
    });
  }

  it('refuses a last day before the first, and takes a leave of one day', async () => {
    const p = await practice();
    await expect(row(p, { toDate: '2026-10-04' })).rejects.toThrow(/leave_ends_after_it_starts/);
    await expect(row(p, { toDate: '2026-10-05' })).resolves.toBeTruthy();
  });

  it('refuses the person away as the leave\'s coverer', async () => {
    const p = await practice();
    await expect(row(p, { coveringClinicianId: p.nour.id })).rejects.toThrow(/leave_coverer_is_not_away/);
  });

  it('refuses the person away as their own supervision cover, and takes no cover at all (P1-3)', async () => {
    const p = await practice();
    await expect(row(p, { coveringSupervisorId: p.nour.id })).rejects.toThrow(/leave_supervision_cover_is_not_away/);
    await expect(row(p)).resolves.toMatchObject({ coveringSupervisorId: null });
  });

  it('refuses two live leaves sharing even one day, and allows the day after, another person, and a cancelled leave\'s dates', async () => {
    const p = await practice();
    const first = await row(p);

    // Inclusive at both ends: the 27th is in both.
    await expect(row(p, { fromDate: '2026-11-27', toDate: '2026-12-04' })).rejects.toThrow(/leave_no_overlap/);
    await expect(row(p, { fromDate: '2026-11-28', toDate: '2026-12-04' })).resolves.toBeTruthy();
    await expect(row(p, { userId: p.kai.id })).resolves.toBeTruthy();

    await prisma.leave.update({ where: { id: first.id }, data: { cancelledAt: new Date(), overrideId: null } });
    await expect(row(p, { fromDate: '2026-10-12', toDate: '2026-10-16' })).resolves.toBeTruthy();
  });

  it('holds the calendar row exactly while the leave is live', async () => {
    const p = await practice();
    await expect(row(p, { overrideId: null })).rejects.toThrow(/leave_calendar_row_while_live/);
    await expect(row(p, { cancelledAt: new Date() })).rejects.toThrow(/leave_calendar_row_while_live/);
    await expect(row(p, { cancelledAt: new Date(), overrideId: null })).resolves.toBeTruthy();
  });

  it('will not let the calendar row be deleted out from under a live leave', async () => {
    const p = await practice();
    const leave = await row(p);
    await expect(prisma.availabilityOverride.delete({ where: { id: leave.overrideId! } }))
      .rejects.toThrow(/Leave_overrideId_fkey|foreign key/i);
  });

  it('refuses the person away as a client\'s coverer, on insert and on update', async () => {
    const p = await practice();
    const leave = await row(p);
    const cover = (coveringClinicianId: string) => prisma.leaveCoverage.create({
      data: { leaveId: leave.id, clientId: p.client.id, coveringClinicianId, decidedById: p.sam.id },
    });

    await expect(cover(p.nour.id)).rejects.toThrow(/leave_coverage_coverer_is_not_away/);
    const kai = await cover(p.kai.id);
    await expect(prisma.leaveCoverage.update({ where: { id: kai.id }, data: { coveringClinicianId: p.nour.id } }))
      .rejects.toThrow(/leave_coverage_coverer_is_not_away/);
  });

  it('holds one coverage decision per client per leave', async () => {
    const p = await practice();
    const leave = await row(p);
    const data = { leaveId: leave.id, clientId: p.client.id, coveringClinicianId: p.kai.id, decidedById: p.sam.id };
    await prisma.leaveCoverage.create({ data });
    await expect(prisma.leaveCoverage.create({ data })).rejects.toThrow(/leaveId_clientId/);
  });

  it('lets an alert name the leave that chose its reader', async () => {
    const p = await practice();
    const leave = await row(p);
    const alert = await prisma.alert.create({
      data: { recipientId: p.dev.id, clientId: p.client.id, kind: 'inbound_unparsed', coveringLeaveId: leave.id },
    });
    expect(alert.coveringLeaveId).toBe(leave.id);
  });
});

// ─────────────────── recording a leave ───────────────────

describe('recording a leave (story 1, P0-7, P0-9)', () => {
  it('writes the leave, its calendar row and one audit row, together', async () => {
    const { ray, nour, dev, leave } = await onLeave();

    expect(leave).toMatchObject({
      userId: nour.id, coveringClinicianId: dev.id, plannedById: ray.id, cancelledAt: null,
      fromDate: dbDate(NOUR_AWAY.fromDate), toDate: dbDate(NOUR_AWAY.toDate),
    });
    // D-12: the calendar says `Leave` and nothing about why.
    expect(await prisma.availabilityOverride.findUniqueOrThrow({ where: { id: leave.overrideId! } })).toMatchObject({
      userId: nour.id, kind: 'unavailable', startMinute: null, endMinute: null, reason: 'Leave',
      fromDate: dbDate(NOUR_AWAY.fromDate), toDate: dbDate(NOUR_AWAY.toDate),
    });
    expect(await leaveAudit()).toMatchObject([
      { actorId: ray.id, action: 'create', resourceId: leave.id, clientId: null, allowed: true, reason: null },
    ]);
  });

  it('answers overlapping weeks with a Conflict, and leaves no calendar row or audit row behind', async () => {
    const { ray, nour, kai } = await onLeave();
    await expect(createLeave(
      actor(ray), { userId: nour.id, fromDate: '2026-11-27', toDate: '2026-12-04', coveringClinicianId: kai.id }, RECORDED,
    )).rejects.toMatchObject({ name: 'Conflict', code: 'leave_overlaps' });

    expect(await prisma.availabilityOverride.count()).toBe(1);
    expect(await leaveAudit()).toHaveLength(1);
  });

  it('is the practice manager\'s to record: a supervisor is refused, on the record', async () => {
    const { sam, nour, dev } = await practice();
    await expect(createLeave(actor(sam), { userId: nour.id, ...NOUR_AWAY, coveringClinicianId: dev.id }, RECORDED))
      .rejects.toThrow(Forbidden);
    expect(await leaveAudit()).toMatchObject([{ actorId: sam.id, action: 'create', allowed: false }]);
    expect(await prisma.leave.count()).toBe(0);
  });

  it('refuses a leave that starts before today, or ends before it starts', async () => {
    const { ray, nour, dev } = await practice();
    const record = (fromDate: LocalDate, toDate: LocalDate) =>
      createLeave(actor(ray), { userId: nour.id, fromDate, toDate, coveringClinicianId: dev.id }, RECORDED);

    await expect(record('2026-09-10', '2026-09-20')).rejects.toMatchObject({ code: 'leave_starts_past' });
    await expect(record('2026-10-05', '2026-10-04')).rejects.toMatchObject({ code: 'leave_ends_before_start' });
    // Today is not the past.
    await expect(record('2026-09-11', '2026-09-11')).resolves.toBeTruthy();
  });

  it('refuses a coverer who is not a clinician here for the whole leave (D-13, P0-8)', async () => {
    const { ray, sam, nour, dev, kai } = await practice();
    const associate = await makeUser('associate', { supervisorId: sam.id });
    const desk = await makeUser('front_desk');
    const gone = await makeUser('therapist');
    await prisma.user.update({ where: { id: gone.id }, data: { active: false } });
    const leaving = await makeUser('therapist');
    await prisma.departure.create({
      data: {
        userId: leaving.id, plannedById: ray.id,
        noticeAt: new Date('2026-09-01T09:00:00Z'), lastDayOn: dbDate('2026-11-20'),
      },
    });
    // Kai's own week off, in the middle of Nour's.
    await createLeave(actor(ray), { userId: kai.id, fromDate: '2026-10-19', toDate: '2026-10-23', coveringClinicianId: dev.id }, RECORDED);

    for (const [who, id] of Object.entries({
      associate: associate.id, desk: desk.id, admin: ray.id, gone: gone.id,
      nour: nour.id, leaving: leaving.id, away: kai.id,
    })) {
      await expect(
        createLeave(actor(ray), { userId: nour.id, ...NOUR_AWAY, coveringClinicianId: id }, RECORDED), who,
      ).rejects.toMatchObject({ code: 'coverer_unavailable' });
    }
    expect(await prisma.leave.count({ where: { userId: nour.id } })).toBe(0);

    // A supervisor may cover: their notes need nobody's countersignature.
    await expect(createLeave(actor(ray), { userId: nour.id, ...NOUR_AWAY, coveringClinicianId: sam.id }, RECORDED))
      .resolves.toBeTruthy();
  });
});

describe('who covers the supervision (P1-3, D-22)', () => {
  /** Sam supervises Nour and is away; Rosa, a second supervisor, could stand in. */
  async function samAway() {
    const p = await practice();
    const rosa = await makeUser('supervisor');
    return { ...p, rosa, input: { userId: p.sam.id, ...NOUR_AWAY, coveringClinicianId: p.dev.id } };
  }

  it('refuses a leave for somebody who supervises anyone until a supervision cover is named', async () => {
    const { ray, rosa, input } = await samAway();
    await expect(createLeave(actor(ray), input, RECORDED)).rejects.toMatchObject({ code: 'supervision_uncovered' });
    expect(await prisma.leave.count()).toBe(0);
    await expect(createLeave(actor(ray), { ...input, coveringSupervisorId: rosa.id }, RECORDED))
      .resolves.toMatchObject({ coveringSupervisorId: rosa.id });
  });

  it('asks nothing of a leave for somebody who supervises nobody', async () => {
    const { leave } = await onLeave();
    expect(leave.coveringSupervisorId).toBeNull();
  });

  it('refuses a cover who could not countersign, or is not here for the whole leave', async () => {
    const { ray, sam, dev, rosa, input } = await samAway();
    const gone = await makeUser('supervisor');
    await prisma.user.update({ where: { id: gone.id }, data: { active: false } });
    // Rosa's own week off, in the middle of Sam's.
    await createLeave(actor(ray), { userId: rosa.id, fromDate: '2026-10-19', toDate: '2026-10-23', coveringClinicianId: dev.id }, RECORDED);

    for (const [who, id] of Object.entries({ therapist: dev.id, admin: ray.id, gone: gone.id, away: sam.id, 'on leave': rosa.id })) {
      await expect(createLeave(actor(ray), { ...input, coveringSupervisorId: id }, RECORDED), who)
        .rejects.toMatchObject({ code: 'supervision_cover_unavailable' });
    }
    expect(await prisma.leave.count({ where: { userId: sam.id } })).toBe(0);
  });

  it('names, changes and clears the cover on the record, and will not clear it while anybody is supervised', async () => {
    const { ray, rosa, nour, input } = await samAway();
    const other = await makeUser('supervisor');
    const leave = await createLeave(actor(ray), { ...input, coveringSupervisorId: rosa.id }, RECORDED);

    await expect(nameSupervisionCover(actor(rosa), leave.id, other.id, RECORDED)).resolves.toMatchObject({ coveringSupervisorId: other.id });
    await expect(nameSupervisionCover(actor(ray), leave.id, null, RECORDED)).rejects.toMatchObject({ code: 'supervision_uncovered' });
    await prisma.user.update({ where: { id: nour.id }, data: { supervisorId: null } });
    await expect(nameSupervisionCover(actor(ray), leave.id, null, RECORDED)).resolves.toMatchObject({ coveringSupervisorId: null });

    const named = await prisma.auditEvent.findMany({ where: { resource: 'leave', reason: 'leave:supervision_cover_named' } });
    expect(named.map((r) => r.allowed)).toEqual([true, true]);
  });

  it('is scanned on the plan screen: a cover booking their own leave blocks it, and the picker offers only supervisors here', async () => {
    const { ray, dev, rosa, input } = await samAway();
    const leave = await createLeave(actor(ray), { ...input, coveringSupervisorId: rosa.id }, RECORDED);
    const plan = () => getLeavePlan(actor(ray), leave.id, RECORDED);
    expect(await plan()).toMatchObject({ supervisees: 1, supervisionBlocked: false, coveringSupervisor: { id: rosa.id } });
    expect((await plan()).supervisors.map((u) => u.id)).toEqual([rosa.id]);

    await createLeave(actor(ray), { userId: rosa.id, fromDate: '2026-10-19', toDate: '2026-10-23', coveringClinicianId: dev.id }, RECORDED);
    expect(await plan()).toMatchObject({ supervisionBlocked: true, supervisors: [] });
  });
});

// ─────────────────── who covers ───────────────────

describe('who covers which client (story 2, D-15)', () => {
  it('splits one client to Kai on the record, and naming Dev again removes the row rather than copying the leave', async () => {
    const { ray, sam, dev, kai, client, leave } = await onLeave();

    await decideCoverage(actor(sam), leave.id, { clientId: client.id, coveringClinicianId: kai.id }, RECORDED);
    expect(await prisma.leaveCoverage.findMany()).toMatchObject([
      { leaveId: leave.id, clientId: client.id, coveringClinicianId: kai.id, decidedById: sam.id },
    ]);

    await decideCoverage(actor(ray), leave.id, { clientId: client.id, coveringClinicianId: dev.id }, RECORDED);
    expect(await prisma.leaveCoverage.count()).toBe(0);

    expect((await leaveAudit()).filter((r) => r.action === 'update').map((r) => [r.actorId, r.clientId, r.reason]))
      .toEqual([[sam.id, client.id, 'leave:coverage_decided'], [ray.id, client.id, 'leave:coverage_decided']]);
  });

  it('refuses a client who is not on the caseload, and a coverer who could not cover', async () => {
    const { sam, nour, dev, client, leave } = await onLeave();
    const devsOwn = await makeClient(dev.id);
    const associate = await makeUser('associate', { supervisorId: sam.id });

    await expect(decideCoverage(actor(sam), leave.id, { clientId: devsOwn.id, coveringClinicianId: sam.id }, RECORDED))
      .rejects.toMatchObject({ code: 'not_on_caseload' });
    for (const id of [associate.id, nour.id]) {
      await expect(decideCoverage(actor(sam), leave.id, { clientId: client.id, coveringClinicianId: id }, RECORDED))
        .rejects.toMatchObject({ code: 'coverer_unavailable' });
    }
    expect(await prisma.leaveCoverage.count()).toBe(0);
  });

  it('is front desk\'s to read and not to write, on the record', async () => {
    const { kai, client, leave } = await onLeave();
    const desk = await makeUser('front_desk');
    await expect(decideCoverage(actor(desk), leave.id, { clientId: client.id, coveringClinicianId: kai.id }, RECORDED))
      .rejects.toThrow(Forbidden);
    expect(await prisma.auditEvent.count({ where: { actorId: desk.id, resource: 'leave', allowed: false } })).toBe(1);
  });

  it('holds a coverer\'s own week off against them only while it is still to come', async () => {
    const { ray, sam, dev, kai, client, leave } = await onLeave();
    await createLeave(actor(ray), { userId: kai.id, fromDate: '2026-10-06', toDate: '2026-10-09', coveringClinicianId: dev.id }, RECORDED);
    const split = (d: LocalDate) =>
      decideCoverage(actor(sam), leave.id, { clientId: client.id, coveringClinicianId: kai.id }, on(d));

    await expect(split('2026-10-07')).rejects.toMatchObject({ code: 'coverer_unavailable' });
    await expect(split('2026-10-12')).resolves.toMatchObject({ coveringClinicianId: kai.id });
  });

  it('names a new coverer for the leave, and drops the per-client row that now says the same thing', async () => {
    const { ray, sam, kai, client, leave } = await onLeave();
    await decideCoverage(actor(sam), leave.id, { clientId: client.id, coveringClinicianId: kai.id }, RECORDED);

    await nameCoverer(actor(ray), leave.id, kai.id, RECORDED);
    expect(await prisma.leave.findUniqueOrThrow({ where: { id: leave.id } })).toMatchObject({ coveringClinicianId: kai.id });
    expect(await prisma.leaveCoverage.count()).toBe(0);
    expect((await leaveAudit()).at(-1)).toMatchObject({ actorId: ray.id, reason: 'leave:coverer_named' });
  });
});

// ─────────────────── dates, early return, cancellation ───────────────────

describe('a leave\'s dates, and its one transition (P0-2, D-10)', () => {
  const override = (id: string) => prisma.availabilityOverride.findUniqueOrThrow({ where: { id } });

  it('moves the calendar row with the leave', async () => {
    const { sam, leave } = await onLeave();
    await editLeaveDates(actor(sam), leave.id, { fromDate: '2026-10-12', toDate: '2026-12-04' }, RECORDED);

    const moved = { fromDate: dbDate('2026-10-12'), toDate: dbDate('2026-12-04') };
    expect(await prisma.leave.findUniqueOrThrow({ where: { id: leave.id } })).toMatchObject(moved);
    expect(await override(leave.overrideId!)).toMatchObject(moved);
    expect((await leaveAudit()).at(-1)).toMatchObject({ actorId: sam.id, reason: 'leave:dates_edited' });
  });

  it('ends early by shortening as far as yesterday — back today — keeps its first day, and is frozen once ended', async () => {
    const { ray, kai, client, leave } = await onLeave();
    const midway = on('2026-10-20');
    const edit = (fromDate: LocalDate, toDate: LocalDate, clock = midway) =>
      editLeaveDates(actor(ray), leave.id, { fromDate, toDate }, clock);

    // A leave whose first day is today cannot end before it.
    await expect(edit('2026-10-05', '2026-10-04', on('2026-10-05'))).rejects.toMatchObject({ code: 'leave_ends_before_start' });
    await expect(edit('2026-10-05', '2026-10-18')).rejects.toMatchObject({ code: 'leave_ends_past' });
    await expect(edit('2026-10-06', '2026-11-27')).rejects.toMatchObject({ code: 'leave_started' });
    await edit('2026-10-05', '2026-10-20');
    await edit('2026-10-05', '2026-10-19');
    expect(await override(leave.overrideId!)).toMatchObject({ toDate: dbDate('2026-10-19') });

    // Ended the moment it committed: frozen the same day.
    await expect(edit('2026-10-05', '2026-10-30')).rejects.toMatchObject({ code: 'leave_frozen' });
    await expect(decideCoverage(actor(ray), leave.id, { clientId: client.id, coveringClinicianId: kai.id }, midway))
      .rejects.toMatchObject({ code: 'leave_frozen' });
    await expect(nameCoverer(actor(ray), leave.id, kai.id, midway)).rejects.toMatchObject({ code: 'leave_frozen' });
    await expect(cancelLeave(actor(ray), leave.id, midway)).rejects.toMatchObject({ code: 'bad_transition' });
  });

  it('extends only where leave_no_overlap allows, and a refused extension leaves the calendar row where it was', async () => {
    const { ray, nour, kai, leave } = await onLeave();
    await createLeave(actor(ray), { userId: nour.id, fromDate: '2026-12-14', toDate: '2026-12-18', coveringClinicianId: kai.id }, RECORDED);

    await expect(editLeaveDates(actor(ray), leave.id, { fromDate: '2026-10-05', toDate: '2026-12-14' }, RECORDED))
      .rejects.toMatchObject({ code: 'leave_overlaps' });
    expect(await override(leave.overrideId!)).toMatchObject({ toDate: dbDate('2026-11-27') });
  });

  it('cancels an upcoming leave, takes its calendar row, frees the dates, and freezes the row', async () => {
    const { ray, nour, dev, leave } = await onLeave();
    const cancelled = await cancelLeave(actor(ray), leave.id, RECORDED);

    expect(cancelled).toMatchObject({ cancelledAt: RECORDED.now(), overrideId: null });
    expect(await prisma.availabilityOverride.count()).toBe(0);
    expect((await leaveAudit()).at(-1)).toMatchObject({ actorId: ray.id, resourceId: leave.id, reason: 'leave:cancelled' });

    await expect(editLeaveDates(actor(ray), leave.id, NOUR_AWAY, RECORDED)).rejects.toMatchObject({ code: 'leave_frozen' });
    await expect(createLeave(actor(ray), { userId: nour.id, ...NOUR_AWAY, coveringClinicianId: dev.id }, RECORDED))
      .resolves.toBeTruthy();
  });

  it('will not cancel a leave that has started — it ends by early return, and keeps the days it was on', async () => {
    const { ray, leave } = await onLeave();
    await expect(cancelLeave(actor(ray), leave.id, on('2026-10-05'))).rejects.toMatchObject({ code: 'bad_transition' });
    expect(await prisma.availabilityOverride.count()).toBe(1);
  });
});

// ─────────────────── the plan screen (Phase 4) ───────────────────

describe('the plan screen\'s read (Phase 4, P0-8)', () => {
  it('lists the caseload with each client\'s coverer, and who decided a split', async () => {
    const { sam, nour, kai, client, leave } = await onLeave();
    const other = await makeClient(nour.id);
    await decideCoverage(actor(sam), leave.id, { clientId: client.id, coveringClinicianId: kai.id }, RECORDED);

    const plan = await getLeavePlan(actor(sam), leave.id, RECORDED);
    expect(plan).toMatchObject({ phase: 'upcoming', ...NOUR_AWAY, unavailable: [] });
    const byId = new Map(plan.clients.map((c) => [c.id, c]));
    expect(byId.get(client.id)?.coverage).toMatchObject({ coveringClinicianId: kai.id, decidedBy: { name: sam.name } });
    expect(byId.get(other.id)?.coverage).toBeNull();
  });

  it('scans every named coverer after naming, and offers only who could cover the rest', async () => {
    const { ray, sam, dev, kai, client, leave } = await onLeave();
    await decideCoverage(actor(sam), leave.id, { clientId: client.id, coveringClinicianId: kai.id }, RECORDED);
    const plan = (clock = RECORDED) => getLeavePlan(actor(ray), leave.id, clock);
    expect((await plan()).unavailable).toEqual([]);

    // Kai books a week off inside Nour's, and Dev gives notice before Nour is back.
    // Each is its own fact to record; the leave learns of it here, not at the door.
    await createLeave(actor(ray), { userId: kai.id, fromDate: '2026-10-19', toDate: '2026-10-23', coveringClinicianId: sam.id }, RECORDED);
    await prisma.departure.create({
      data: { userId: dev.id, plannedById: ray.id, noticeAt: RECORDED.now(), lastDayOn: dbDate('2026-11-20') },
    });
    expect((await plan()).unavailable.sort()).toEqual([dev.id, kai.id].sort());
    expect((await plan()).coverers.map((c) => c.id)).toEqual([sam.id]);

    // Once Kai is back, Kai is here for the rest of it.
    const back = await plan(on('2026-10-26'));
    expect(back.unavailable).toEqual([dev.id]);
    expect(back.coverers.map((c) => c.id).sort()).toEqual([kai.id, sam.id].sort());
  });

  it('is read by front desk and by the person away, and refused to a colleague, on the record', async () => {
    const { nour, dev, leave } = await onLeave();
    const desk = await makeUser('front_desk');
    await expect(getLeavePlan(actor(desk), leave.id, RECORDED)).resolves.toBeTruthy();
    await expect(getLeavePlan(actor(nour), leave.id, RECORDED)).resolves.toBeTruthy();
    await expect(getLeavePlan(actor(dev), leave.id, RECORDED)).rejects.toThrow(Forbidden);
    expect(await prisma.auditEvent.count({ where: { actorId: dev.id, resource: 'leave', allowed: false } })).toBe(1);
  });

  it('lists the leaves not yet over for front desk, and not for a clinician', async () => {
    const { ray, nour, dev, kai, leave } = await onLeave();
    const desk = await makeUser('front_desk');
    const kaiAway = await createLeave(actor(ray), { userId: kai.id, fromDate: '2026-09-14', toDate: '2026-09-18', coveringClinicianId: dev.id }, RECORDED);
    const withdrawn = await createLeave(actor(ray), { userId: dev.id, fromDate: '2026-12-01', toDate: '2026-12-04', coveringClinicianId: kai.id }, RECORDED);
    await cancelLeave(actor(ray), withdrawn.id, RECORDED);

    expect((await listLeaves(actor(desk), on('2026-09-15'))).map((l) => [l.id, l.phase, l.coveringClinician.name]))
      .toEqual([[kaiAway.id, 'active', dev.name], [leave.id, 'upcoming', dev.name]]);
    expect((await listLeaves(actor(desk), on('2026-09-19'))).map((l) => l.id)).toEqual([leave.id]);
    await expect(listLeaves(actor(nour), RECORDED)).rejects.toThrow(Forbidden);
  });
});

describe('the work-list counts (P1-5, P1-1)', () => {
  const unread = (recipientId: string, clientId: string, acknowledgedAt: Date | null = null) =>
    prisma.alert.create({ data: { recipientId, clientId, kind: 'inbound_unparsed', acknowledgedAt } });

  it('counts each leave\'s caseload, coverers who cannot cover, and alerts still with the person away, naming no client', async () => {
    const { ray, sam, nour, dev, kai, client, leave } = await onLeave();
    const desk = await makeUser('front_desk');
    await makeClient(nour.id);
    await unread(nour.id, client.id);
    await unread(nour.id, client.id);
    await unread(nour.id, client.id, RECORDED.now());
    await decideCoverage(actor(sam), leave.id, { clientId: client.id, coveringClinicianId: kai.id }, RECORDED);
    await createLeave(actor(ray), { userId: kai.id, fromDate: '2026-10-19', toDate: '2026-10-23', coveringClinicianId: sam.id }, RECORDED);

    const nours = async (clock = RECORDED) => {
      const rows = await leaveWorklist(actor(desk), clock);
      expect(JSON.stringify(rows)).not.toContain(client.id);
      return rows.find((r) => r.id === leave.id);
    };
    expect(await nours()).toEqual({
      id: leave.id, name: nour.name, coverer: dev.name, ...NOUR_AWAY, phase: 'upcoming',
      clients: 2, unavailableCoverers: 1, unreadAlerts: 2,
    });

    // Day one before the sweep: the number is the lateness. After it: nothing waits.
    const dayOne = on('2026-10-05');
    expect(await nours(dayOne)).toMatchObject({ phase: 'active', unreadAlerts: 2 });
    await runLeaveAlertSweep(dayOne);
    expect(await nours(dayOne)).toMatchObject({ phase: 'active', unreadAlerts: 0 });

    await expect(leaveWorklist(actor(dev), RECORDED)).rejects.toThrow(Forbidden);
  });

  it('counts unread alerts to somebody away today with no leave behind it, and never a leave\'s own days', async () => {
    const { ray, nour, dev, kai, client } = await onLeave();
    const devs = await makeClient(dev.id);
    const kais = await makeClient(kai.id);
    const override = (userId: string, day: LocalDate, kind: 'unavailable' | 'available' = 'unavailable') =>
      prisma.availabilityOverride.create({ data: { userId, fromDate: dbDate(day), toDate: dbDate(day), kind } });
    await override(dev.id, '2026-09-11');
    await override(dev.id, '2026-09-12', 'available');
    await override(kai.id, '2026-09-14');
    await unread(dev.id, devs.id);
    await unread(dev.id, devs.id, RECORDED.now());
    await unread(kai.id, kais.id);
    await unread(nour.id, client.id);

    expect(await uncoveredAbsenceAlerts(actor(ray), RECORDED)).toBe(1);
    expect(await uncoveredAbsenceAlerts(actor(ray), on('2026-09-12'))).toBe(0);
    expect(await uncoveredAbsenceAlerts(actor(ray), on('2026-09-14'))).toBe(1);
    // Nour's leave has a calendar row too, and an unswept alert behind it: covered, not a gap.
    expect(await uncoveredAbsenceAlerts(actor(ray), on('2026-10-05'))).toBe(0);
  });
});

// ─────────────────── P1-4: while you were away ───────────────────

describe('while you were away (P1-4, D-25)', () => {
  const quiet = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`item_${i + 1}`, 0]));
  const critical = { ...quiet, item_9: 2 };

  /** A session on a client, and optionally a progress note by its clinician, all synthetic. */
  async function session(clientId: string, clinicianId: string, day: LocalDate, opts: { status?: 'completed' | 'cancelled'; note?: boolean } = {}) {
    const appt = await prisma.appointment.create({
      data: { clientId, clinicianId, modality: 'telehealth', status: opts.status ?? 'completed', startAt: zonedToUtc(day, 600), endAt: zonedToUtc(day, 650) },
    });
    const note = opts.note ? await prisma.progressNote.create({ data: { appointmentId: appt.id, clientId, authorId: clinicianId, content: 'synthetic' } }) : null;
    return { appt, note };
  }

  it('lists the window\'s flagged screeners, the sessions others held and their notes, on reads Nour holds as treating', async () => {
    const p = await onLeave();
    const desk = await makeUser('front_desk');
    await publishTemplate(actor(p.ray), { key: 'wellbeing-check-in', name: 'Wellbeing Check-In', kind: 'screener', ...wellbeingCheckIn });
    const submit = async (d: LocalDate, answers: Record<string, number>) => {
      const req = await issueForm(actor(desk), { clientId: p.client.id, templateKey: 'wellbeing-check-in', clock: on(d) });
      await submitForm(req.token, answers, { clock: on(d) });
    };
    await submit('2026-10-02', critical); // before Nour left
    await submit('2026-10-06', critical);
    await submit('2026-10-07', quiet); // in the window, nothing flagged
    await submit('2026-11-28', critical); // Nour is back
    const flagged = (await prisma.formSubmission.findMany({ select: { id: true, request: { select: { submittedAt: true } } } }))
      .filter((s) => localDateOf(s.request.submittedAt!) === '2026-10-06');

    const held = await session(p.client.id, p.dev.id, '2026-10-06', { note: true });
    await session(p.client.id, p.dev.id, '2026-10-13', { status: 'cancelled' });
    await session(p.client.id, p.nour.id, '2026-10-09', { note: true }); // Nour's own, from home, inside the window
    await session(p.client.id, p.dev.id, '2026-11-28', { note: true }); // after the window
    await session((await makeClient(p.dev.id)).id, p.dev.id, '2026-10-08', { note: true }); // Dev's own client
    const covering = await prisma.processNote.create({ data: { clientId: p.client.id, authorId: p.dev.id, content: 'synthetic' } });

    const back = await whileYouWereAway(actor(p.nour), on('2026-11-30'));
    expect(back).toMatchObject({ id: p.leave.id, ...NOUR_AWAY, coverer: p.dev.name });
    expect(back!.flagged.map((s) => s.id)).toEqual(flagged.map((s) => s.id));
    expect(back!.sessions.map((a) => a.id)).toEqual([held.appt.id]);
    expect(back!.notes.map((n) => n.id)).toEqual([held.note!.id]);
    expect(JSON.stringify(back)).not.toContain(covering.id);

    const reads = await prisma.auditEvent.findMany({ where: { actorId: p.nour.id } });
    expect(reads.map((r) => r.resource).sort()).toEqual(['appointment', 'form_submission', 'progress_note']);
    expect(reads.every((r) => r.allowed && !r.reason?.startsWith('leave:'))).toBe(true);
  });

  it('is there for two weeks after the last day, only for the person who was away, and reads nothing otherwise', async () => {
    const p = await onLeave();
    const desk = await makeUser('front_desk');
    await createLeave(actor(p.ray), { userId: desk.id, fromDate: '2026-09-14', toDate: '2026-09-18', coveringClinicianId: p.dev.id }, RECORDED);

    expect(await whileYouWereAway(actor(p.nour), on(NOUR_AWAY.toDate))).toBeNull();
    expect(await whileYouWereAway(actor(p.nour), on('2026-12-11'))).not.toBeNull();
    expect(await whileYouWereAway(actor(p.nour), on('2026-12-12'))).toBeNull();
    expect(await whileYouWereAway(actor(p.dev), on('2026-11-30'))).toBeNull();
    // Front desk away has no caseload to be told about, and no denial per page load.
    expect(await whileYouWereAway(actor(desk), on('2026-09-21'))).toBeNull();

    expect(await prisma.auditEvent.count({ where: { actorId: { in: [p.nour.id, p.dev.id, desk.id] } } })).toBe(3);
  });
});
