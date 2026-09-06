import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { actor, makeClient, makeUser, resetDb } from '../test/harness';
import { isBreakGlassRef, isBreakGlassReason } from './break-glass';
import { breakGlassWouldHelp, guarded, may } from './guard';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('every access leaves exactly one audit row', () => {
  it('logs a granted read together with the work, in one transaction', async () => {
    const therapist = await makeUser('therapist');
    const client = await makeClient(therapist.id);

    const got = await guarded(
      {
        actor: actor(therapist),
        action: 'read',
        resource: 'client',
        target: { clinicianId: therapist.id },
        resourceId: client.id,
        clientId: client.id,
      },
      (tx) => tx.client.findUniqueOrThrow({ where: { id: client.id } }),
    );

    expect(got.id).toBe(client.id);
    const rows = await prisma.auditEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: therapist.id,
      actorRole: 'therapist',
      action: 'read',
      resource: 'client',
      resourceId: client.id,
      clientId: client.id,
      allowed: true,
      rule: 'treatingOrSupervising',
      breakGlass: false,
      reason: null,
    });
  });

  it('logs a denial and refuses the work', async () => {
    const desk = await makeUser('front_desk');
    const therapist = await makeUser('therapist');
    const client = await makeClient(therapist.id);
    let ran = false;

    await expect(
      guarded(
        { actor: actor(desk), action: 'read', resource: 'progress_note', clientId: client.id },
        async () => { ran = true; },
      ),
    ).rejects.toBeInstanceOf(Forbidden);

    expect(ran).toBe(false);
    const [row] = await prisma.auditEvent.findMany();
    expect(row).toMatchObject({ allowed: false, rule: 'never', actorRole: 'front_desk' });
  });

  it('rolls the audit row back when the work fails', async () => {
    const therapist = await makeUser('therapist');
    const client = await makeClient(therapist.id);

    await expect(
      guarded(
        {
          actor: actor(therapist), action: 'read', resource: 'client',
          target: { clinicianId: therapist.id }, clientId: client.id,
        },
        async () => { throw new Error('boom'); },
      ),
    ).rejects.toThrow('boom');

    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe('break-glass', () => {
  it('grants demographics, flagged, with the reason attached', async () => {
    const admin = await makeUser('admin');
    const therapist = await makeUser('therapist');
    const client = await makeClient(therapist.id);

    await guarded(
      {
        actor: actor(admin, 'clinician_unavailable'),
        action: 'read', resource: 'client', resourceId: client.id, clientId: client.id,
      },
      (tx) => tx.client.findUniqueOrThrow({ where: { id: client.id } }),
    );

    const [row] = await prisma.auditEvent.findMany();
    expect(row).toMatchObject({
      allowed: true,
      rule: 'breakGlass',
      breakGlass: true,
      reason: 'clinician_unavailable',
    });
  });

  it('is denied at a process note, and the attempt is flagged', async () => {
    const admin = await makeUser('admin');
    const therapist = await makeUser('therapist');
    const client = await makeClient(therapist.id);

    await expect(
      guarded(
        {
          actor: actor(admin, 'records_request'),
          action: 'read', resource: 'process_note',
          target: { authorId: therapist.id, clinicianId: therapist.id },
          clientId: client.id,
        },
        async () => 'never reached',
      ),
    ).rejects.toMatchObject({ absolute: true });

    const [row] = await prisma.auditEvent.findMany();
    expect(row).toMatchObject({ allowed: false, breakGlass: true, resource: 'process_note' });
  });

  it('a supervisor is denied a supervisee process note, and it is logged', async () => {
    const boss = await makeUser('supervisor');
    const assoc = await makeUser('associate', { supervisorId: boss.id });
    const client = await makeClient(assoc.id);

    await expect(
      guarded(
        {
          actor: actor(boss), action: 'read', resource: 'process_note',
          target: { authorId: assoc.id, authorSupervisorId: boss.id, clinicianId: assoc.id },
          clientId: client.id,
        },
        async () => 'never reached',
      ),
    ).rejects.toBeInstanceOf(Forbidden);

    const [row] = await prisma.auditEvent.findMany();
    expect(row).toMatchObject({ actorId: boss.id, allowed: false, resource: 'process_note' });
  });
});

describe('the log is append-only at the database layer', () => {
  const seed = async () => {
    const therapist = await makeUser('therapist');
    const client = await makeClient(therapist.id);
    await guarded(
      {
        actor: actor(therapist), action: 'read', resource: 'client',
        target: { clinicianId: therapist.id }, clientId: client.id,
      },
      async () => null,
    );
    return prisma.auditEvent.findFirstOrThrow();
  };

  it('refuses UPDATE', async () => {
    const row = await seed();
    await expect(
      prisma.$executeRaw`UPDATE "AuditEvent" SET allowed = false WHERE id = ${row.id}`,
    ).rejects.toThrow(/append-only/);
  });

  it('refuses DELETE', async () => {
    const row = await seed();
    await expect(
      prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE id = ${row.id}`,
    ).rejects.toThrow(/append-only/);
  });

  it('refuses the ORM update path too', async () => {
    const row = await seed();
    await expect(
      prisma.auditEvent.update({ where: { id: row.id }, data: { rule: 'always' } }),
    ).rejects.toThrow(/append-only/);
  });
});

it('carries no PHI — ids only', async () => {
  const therapist = await makeUser('therapist', { name: 'Dana Okonkwo' });
  const client = await prisma.client.create({
    data: {
      code: 'TC-999', firstName: 'Marguerite', lastName: 'Vandersteen',
      dateOfBirth: new Date('1988-02-02'), treatingClinicianId: therapist.id,
      email: 'marguerite@example.test',
    },
  });

  await guarded(
    {
      actor: actor(therapist), action: 'read', resource: 'client',
      target: { clinicianId: therapist.id }, resourceId: client.id, clientId: client.id,
    },
    async () => null,
  );

  const rows = await prisma.auditEvent.findMany();
  const dump = JSON.stringify(rows);
  for (const leak of ['Marguerite', 'Vandersteen', 'marguerite@example.test', 'Dana', 'Okonkwo']) {
    expect(dump).not.toContain(leak);
  }
});

describe('what a break-glass session puts in the audit row', () => {
  /**
   * The row is the only lasting record of an administrator in a clinical file,
   * and it is append-only, so whatever lands here lands permanently in front of
   * the auditor — the one role that may read this table and may never read a
   * note. It carries a code and, at most, a case identifier.
   */
  it('writes the code and the reference, and nothing else', async () => {
    const therapist = await makeUser('therapist');
    const admin = await makeUser('admin');
    const client = await makeClient(therapist.id);

    await guarded(
      {
        actor: { ...actor(admin), breakGlass: { reason: 'legal_request', ref: '2026-114' } },
        action: 'read', resource: 'client', resourceId: client.id, clientId: client.id,
      },
      async () => null,
    );

    const [row] = await prisma.auditEvent.findMany({ where: { breakGlass: true } });
    expect(row).toMatchObject({ reason: 'legal_request', reasonRef: '2026-114', allowed: true });
  });

  it('leaves the reference null when there is none', async () => {
    const therapist = await makeUser('therapist');
    const admin = await makeUser('admin');
    const client = await makeClient(therapist.id);

    await guarded(
      {
        actor: actor(admin, 'safety_check'),
        action: 'read', resource: 'client', resourceId: client.id, clientId: client.id,
      },
      async () => null,
    );

    const [row] = await prisma.auditEvent.findMany({ where: { breakGlass: true } });
    expect(row).toMatchObject({ reason: 'safety_check', reasonRef: null });
  });

  it('carries the reason onto the denial too, and onto every row of the session', async () => {
    const therapist = await makeUser('therapist');
    const admin = await makeUser('admin');
    const client = await makeClient(therapist.id);
    const open = { ...actor(admin), breakGlass: { reason: 'safety_check' as const } };

    await guarded(
      { actor: open, action: 'read', resource: 'client', resourceId: client.id, clientId: client.id },
      async () => null,
    );
    await expect(
      guarded(
        {
          actor: open, action: 'read', resource: 'process_note',
          target: { authorId: therapist.id }, clientId: client.id,
        },
        async () => null,
      ),
    ).rejects.toBeInstanceOf(Forbidden);

    const rows = await prisma.auditEvent.findMany({ orderBy: { resource: 'asc' } });
    expect(rows.map((r) => [r.resource, r.allowed, r.reason])).toEqual([
      ['client', true, 'safety_check'],
      ['process_note', false, 'safety_check'],
    ]);
  });

  it('never holds a sentence: every reason on the table is a code or nothing', async () => {
    const therapist = await makeUser('therapist');
    const admin = await makeUser('admin');
    const client = await makeClient(therapist.id);

    await guarded(
      { actor: actor(therapist), action: 'read', resource: 'client', target: { clinicianId: therapist.id }, clientId: client.id },
      async () => null,
    );
    await guarded(
      { actor: actor(admin, 'billing_query'), action: 'read', resource: 'client', clientId: client.id },
      async () => null,
    );

    for (const row of await prisma.auditEvent.findMany()) {
      expect(row.reason === null || isBreakGlassReason(row.reason), `${row.reason}`).toBe(true);
      expect(row.reasonRef === null || isBreakGlassRef(row.reasonRef), `${row.reasonRef}`).toBe(true);
    }
  });
});

describe('whether break-glass would change the answer', () => {
  // This decides which refusal a person is shown. Every existing test asks it
  // about a door that is shut; none asked about one already open, so inverting
  // the early return changed nothing the suite could see.
  it('is false when the actor may already do it — an open door is not offered', async () => {
    const therapist = await makeUser('therapist');
    const client = await makeClient(therapist.id);
    expect(breakGlassWouldHelp({
      actor: actor(therapist), action: 'read', resource: 'client',
      target: { clinicianId: therapist.id }, resourceId: client.id, clientId: client.id,
    })).toBe(false);
  });

  it('is true for the practice manager, for whom it is the whole difference', async () => {
    const therapist = await makeUser('therapist');
    const admin = await makeUser('admin');
    const client = await makeClient(therapist.id);
    expect(breakGlassWouldHelp({
      actor: actor(admin), action: 'read', resource: 'client',
      resourceId: client.id, clientId: client.id,
    })).toBe(true);
  });

  it('is false at a process note, because that door does not open for anyone', async () => {
    const therapist = await makeUser('therapist');
    const admin = await makeUser('admin');
    const client = await makeClient(therapist.id);
    expect(breakGlassWouldHelp({
      actor: actor(admin), action: 'read', resource: 'process_note',
      target: { authorId: therapist.id }, clientId: client.id,
    })).toBe(false);
  });
});

it('may() answers without logging — drawing a button is not an access event', async () => {
  const desk = await makeUser('front_desk');
  expect(may({ actor: actor(desk), action: 'read', resource: 'progress_note' })).toBe(false);
  expect(may({ actor: actor(desk), action: 'read', resource: 'appointment' })).toBe(true);
  expect(await prisma.auditEvent.count()).toBe(0);
});
