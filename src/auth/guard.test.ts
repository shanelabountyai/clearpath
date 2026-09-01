import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { Forbidden } from '../errors.js';
import { actor, makeClient, makeUser, resetDb } from '../test/harness.js';
import { guarded, may } from './guard.js';

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
      rule: 'treating',
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
        actor: actor(admin, 'client in crisis, clinician unreachable'),
        action: 'read', resource: 'client', resourceId: client.id, clientId: client.id,
      },
      (tx) => tx.client.findUniqueOrThrow({ where: { id: client.id } }),
    );

    const [row] = await prisma.auditEvent.findMany();
    expect(row).toMatchObject({
      allowed: true,
      rule: 'breakGlass',
      breakGlass: true,
      reason: 'client in crisis, clinician unreachable',
    });
  });

  it('is denied at a process note, and the attempt is flagged', async () => {
    const admin = await makeUser('admin');
    const therapist = await makeUser('therapist');
    const client = await makeClient(therapist.id);

    await expect(
      guarded(
        {
          actor: actor(admin, 'audit request'),
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

it('may() answers without logging — drawing a button is not an access event', async () => {
  const desk = await makeUser('front_desk');
  expect(may({ actor: actor(desk), action: 'read', resource: 'progress_note' })).toBe(false);
  expect(may({ actor: actor(desk), action: 'read', resource: 'appointment' })).toBe(true);
  expect(await prisma.auditEvent.count()).toBe(0);
});
