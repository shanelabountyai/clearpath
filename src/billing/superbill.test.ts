import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { fixedClock } from '../clock';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { setStatus } from '../scheduling/lifecycle';
import { zonedToUtc } from '../time';
import {
  buildSuperbill, cptFor, superbillCsv, superbillLines, totalCents, type BillableSession,
} from './superbill';

const session = (o: Partial<BillableSession> = {}): BillableSession => ({
  startAt: new Date('2026-03-10T15:00:00Z'),
  type: 'standard',
  modality: 'in_person',
  status: 'completed',
  chargeFeeCents: 18000,
  clinicianName: 'Dana Reyes',
  ...o,
});

describe('service codes', () => {
  it('derives the code from the length of the session', () => {
    expect(cptFor('intake', 'in_person').code).toBe('90791');
    expect(cptFor('standard', 'in_person').code).toBe('90834');
    expect(cptFor('extended', 'in_person').code).toBe('90837');
  });

  it('marks telehealth with modifier 95 and place of service 02', () => {
    const remote = cptFor('standard', 'telehealth');
    expect(remote.modifier).toBe('95');
    expect(remote.placeOfService).toBe('02');
  });

  it('leaves an in-person session unmodified, in the office', () => {
    const inPerson = cptFor('standard', 'in_person');
    expect(inPerson.modifier).toBeNull();
    expect(inPerson.placeOfService).toBe('11');
  });
});

describe('what lands on the bill', () => {
  it('bills a completed session at the fee recorded when it completed', () => {
    const [line] = superbillLines([session({ chargeFeeCents: 12500 })]);
    expect(line!.feeCents).toBe(12500);
    expect(line!.units).toBe(1);
  });

  it('leaves off everything that is not a service rendered', () => {
    const lines = superbillLines([
      session({ status: 'no_show', chargeFeeCents: 9000 }),
      session({ status: 'late_cancelled', chargeFeeCents: 9000 }),
      session({ status: 'cancelled' }),
      session({ status: 'scheduled' }),
    ]);
    expect(lines).toEqual([]);
  });

  it('is ordered by date of service', () => {
    const lines = superbillLines([
      session({ startAt: new Date('2026-03-24T15:00:00Z') }),
      session({ startAt: new Date('2026-03-10T15:00:00Z') }),
      session({ startAt: new Date('2026-03-17T15:00:00Z') }),
    ]);
    expect(lines.map((l) => l.date)).toEqual(['2026-03-10', '2026-03-17', '2026-03-24']);
  });

  it('totals in integer cents, never a float', () => {
    const total = totalCents(superbillLines([
      session({ chargeFeeCents: 18000 }),
      session({ chargeFeeCents: 12500 }),
      session({ chargeFeeCents: 9950 }),
    ]));
    expect(total).toBe(40450);
    expect(Number.isInteger(total)).toBe(true);
  });

  it('bills a session with no recorded fee at zero rather than guessing', () => {
    expect(superbillLines([session({ chargeFeeCents: null })])[0]!.feeCents).toBe(0);
  });
});

describe('the exported document', () => {
  const bill = {
    client: { id: 'c1', code: 'TC-001', name: 'Test Client 001', dateOfBirth: new Date('1990-04-12') },
    practice: 'Stillwater Counseling',
    range: { from: '2026-03-01', to: '2026-03-31' },
    lines: superbillLines([session({ chargeFeeCents: 18000 }), session({ chargeFeeCents: 12500 })]),
    totalCents: 30500,
    omissions: ['No diagnosis (ICD-10) code'],
  };

  it('carries a header, the lines, and a total', () => {
    const rows = superbillCsv(bill).split('\n');
    expect(rows[0]).toContain('code,description');
    expect(rows[1]).toContain('90834');
    const total = rows.find((r) => r.includes('TOTAL'))!;
    expect(total.split(',')[6]).toBe('305.00');
  });

  it('states what it is missing instead of looking complete', () => {
    expect(superbillCsv(bill)).toContain('No diagnosis (ICD-10) code');
  });
});

describe('who may produce one', () => {
  const MARCH = { from: '2026-03-01', to: '2026-03-31' };
  const clock = fixedClock('2026-03-10T20:00:00Z');

  let desk: Awaited<ReturnType<typeof makeUser>>;
  let mine: Awaited<ReturnType<typeof makeUser>>;
  let other: Awaited<ReturnType<typeof makeUser>>;
  let boss: Awaited<ReturnType<typeof makeUser>>;
  let client: Awaited<ReturnType<typeof makeClient>>;

  beforeEach(async () => {
    await resetDb();
    await settings({ standardFeeCents: 18000 });
    desk = await makeUser('front_desk');
    boss = await makeUser('admin');
    mine = await makeUser('therapist');
    other = await makeUser('therapist');
    client = await makeClient(mine.id, { feeCents: 12500 });

    const room = await makeRoom('Room 1');
    const appt = await prisma.appointment.create({
      data: {
        clientId: client.id, clinicianId: mine.id, roomId: room.id,
        startAt: zonedToUtc('2026-03-10', 15 * 60),
        endAt: zonedToUtc('2026-03-10', 15 * 60 + 50),
        type: 'standard', modality: 'in_person', status: 'arrived',
      },
    });
    // Through the lifecycle, so the fee on the bill is the one the completion
    // recorded rather than one the export computed for itself.
    await setStatus(actor(desk), appt.id, 'in_session', { clock });
    await setStatus(actor(desk), appt.id, 'completed', { clock });
  });

  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it('bills the sliding-scale fee the session actually completed at', async () => {
    const bill = await buildSuperbill(actor(desk), client.id, MARCH);
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]!.code).toBe('90834');
    expect(bill.totalCents).toBe(12500);
    expect(bill.client.name).toBe(`Test Client ${client.lastName.split(' ')[1]}`);
  });

  it('lets the treating clinician produce one for their own client', async () => {
    await expect(buildSuperbill(actor(mine), client.id, MARCH)).resolves.toMatchObject({
      totalCents: 12500,
    });
  });

  it('refuses a clinician who does not treat this client', async () => {
    await expect(buildSuperbill(actor(other), client.id, MARCH)).rejects.toBeInstanceOf(Forbidden);
  });

  it('refuses the practice manager without break-glass, because it carries demographics', async () => {
    await expect(buildSuperbill(actor(boss), client.id, MARCH)).rejects.toBeInstanceOf(Forbidden);

    const denial = await prisma.auditEvent.findFirst({
      where: { actorId: boss.id, allowed: false },
      orderBy: { at: 'desc' },
    });
    expect(denial?.resource).toBe('client');
  });

  it('lets the practice manager produce one through break-glass, flagged', async () => {
    const bill = await buildSuperbill(actor(boss, 'client requested superbill'), client.id, MARCH);
    expect(bill.totalCents).toBe(12500);

    const flagged = await prisma.auditEvent.findMany({ where: { actorId: boss.id, breakGlass: true, allowed: true } });
    expect(flagged.map((r) => r.resource).sort()).toEqual(['client', 'fee']);
  });

  it('logs the fee read and the demographics read as two events, in one transaction', async () => {
    await buildSuperbill(actor(desk), client.id, MARCH);
    const rows = await prisma.auditEvent.findMany({ where: { actorId: desk.id, action: 'read' } });
    expect(rows.map((r) => r.resource).sort()).toEqual(['client', 'fee']);
    expect(rows.every((r) => r.clientId === client.id)).toBe(true);
  });

  it('leaves a no-show inside the range off the bill entirely', async () => {
    const room = await prisma.room.findFirstOrThrow();
    const missed = await prisma.appointment.create({
      data: {
        clientId: client.id, clinicianId: mine.id, roomId: room.id,
        startAt: zonedToUtc('2026-03-17', 15 * 60),
        endAt: zonedToUtc('2026-03-17', 15 * 60 + 50),
        type: 'standard', modality: 'in_person',
      },
    });
    await setStatus(actor(desk), missed.id, 'no_show', { clock });

    const bill = await buildSuperbill(actor(desk), client.id, MARCH);
    expect(bill.lines).toHaveLength(1);
    expect(bill.totalCents).toBe(12500);
  });

  it('excludes sessions outside the range', async () => {
    const bill = await buildSuperbill(actor(desk), client.id, { from: '2026-04-01', to: '2026-04-30' });
    expect(bill.lines).toEqual([]);
    expect(bill.totalCents).toBe(0);
  });
});
