import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { Forbidden } from '../errors.js';
import { actor, makeClient, makeUser, resetDb, settings } from '../test/harness.js';
import { clientAffordances, consentStatus, createClient, effectiveFeeCents, getClient, listClients, setFee, updateClient } from './repository.js';

let desk: Awaited<ReturnType<typeof makeUser>>;
let therapist: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let client: Awaited<ReturnType<typeof makeClient>>;

beforeEach(async () => {
  await resetDb();
  await settings({ standardFeeCents: 18000 });
  desk = await makeUser('front_desk');
  therapist = await makeUser('therapist');
  other = await makeUser('therapist');
  admin = await makeUser('admin');
  client = await makeClient(therapist.id);
});
afterAll(() => prisma.$disconnect());

describe('reading a client record', () => {
  it('front desk reads demographics', async () => {
    const got = await getClient(actor(desk), client.id);
    expect(got.code).toBe(client.code);
    expect(got.treatingClinician.name).toBe(therapist.name);
  });

  it('the treating clinician reads it', async () => {
    await expect(getClient(actor(therapist), client.id)).resolves.toBeTruthy();
  });

  it('another clinician does not', async () => {
    await expect(getClient(actor(other), client.id)).rejects.toBeInstanceOf(Forbidden);
    const [row] = await prisma.auditEvent.findMany({ where: { allowed: false } });
    expect(row).toMatchObject({ actorId: other.id, resource: 'client', clientId: client.id });
  });

  it('the practice manager needs to break glass', async () => {
    await expect(getClient(actor(admin), client.id)).rejects.toBeInstanceOf(Forbidden);
    const got = await getClient(actor(admin, 'client unreachable, welfare check'), client.id);
    expect(got.id).toBe(client.id);
    const flagged = await prisma.auditEvent.findMany({ where: { breakGlass: true, allowed: true } });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toContain('welfare check');
  });

  it('an auditor cannot reach it at all', async () => {
    const auditorUser = await makeUser('auditor');
    await expect(getClient(actor(auditorUser), client.id)).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('the caseload list', () => {
  it('shows a clinician only their own clients', async () => {
    await makeClient(other.id);
    const mine = await listClients(actor(therapist));
    expect(mine.map((c) => c.id)).toEqual([client.id]);
  });

  it('shows front desk everyone, because they book for everyone', async () => {
    await makeClient(other.id);
    expect(await listClients(actor(desk))).toHaveLength(2);
  });

  it('logs one access event for a list, not one per row', async () => {
    await makeClient(other.id);
    await listClients(actor(desk));
    expect(await prisma.auditEvent.count()).toBe(1);
  });
});

describe('consent status', () => {
  const consentTemplate = () =>
    prisma.formTemplate.create({
      data: { key: 'consent-to-treat', name: 'Consent to Treatment', kind: 'consent', version: 1, published: true, schema: {} },
    });

  it('reports never-sent when nothing has been issued', async () => {
    const status = await consentStatus(client.id);
    expect(status).toMatchObject({ neverSent: true, complete: false, outstanding: [] });
  });

  it('reports outstanding until the client signs', async () => {
    const template = await consentTemplate();
    const req = await prisma.formRequest.create({
      data: { clientId: client.id, templateId: template.id, token: 'tok-1', expiresAt: new Date('2027-01-01') },
    });
    expect((await consentStatus(client.id)).outstanding).toHaveLength(1);

    await prisma.formRequest.update({ where: { id: req.id }, data: { status: 'submitted', submittedAt: new Date() } });
    expect(await consentStatus(client.id)).toMatchObject({ complete: true, outstanding: [] });
  });

  it('rides along on the client record, where front desk cannot miss it', async () => {
    const template = await consentTemplate();
    await prisma.formRequest.create({
      data: { clientId: client.id, templateId: template.id, token: 'tok-2', expiresAt: new Date('2027-01-01') },
    });
    const got = await getClient(actor(desk), client.id);
    expect(got.consents.outstanding).toHaveLength(1);
  });
});

describe('fees', () => {
  it('fall back to the practice standard', async () => {
    expect(await effectiveFeeCents(client.id)).toBe(18000);
  });

  it('honour a sliding-scale override', async () => {
    await setFee(actor(admin), client.id, 6500);
    expect(await effectiveFeeCents(client.id)).toBe(6500);
  });

  it('let the practice manager set one without breaking glass', async () => {
    await expect(setFee(actor(admin), client.id, 7000)).resolves.toMatchObject({ feeCents: 7000 });
  });

  it('refuse anything that is not integer cents', async () => {
    await expect(setFee(actor(admin), client.id, 65.5)).rejects.toBeInstanceOf(TypeError);
    await expect(setFee(actor(admin), client.id, -100)).rejects.toBeInstanceOf(TypeError);
  });

  it('are not front desk business to change', async () => {
    await expect(setFee(actor(desk), client.id, 5000)).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('editing', () => {
  it('lets front desk correct demographics', async () => {
    const out = await updateClient(actor(desk), client.id, { phone: '555-0100' });
    expect(out.phone).toBe('555-0100');
  });

  it('lets front desk register a new client', async () => {
    const created = await createClient(actor(desk), {
      code: 'TC-500', firstName: 'Test', lastName: 'Client 500',
      dateOfBirth: new Date('1995-06-06'), treatingClinicianId: therapist.id,
    });
    expect(created.code).toBe('TC-500');
  });

  it('does not let an unrelated clinician edit', async () => {
    await expect(updateClient(actor(other), client.id, { phone: '555' })).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('affordances drive what gets rendered', () => {
  it('give front desk the operational tier and nothing clinical', () => {
    expect(clientAffordances(actor(desk), therapist.id)).toEqual({
      edit: true, setFee: false, readProgressNotes: false, readScreeners: false, readAttendance: false,
    });
  });

  it('give the treating clinician the clinical tier', () => {
    expect(clientAffordances(actor(therapist), therapist.id)).toEqual({
      edit: true, setFee: false, readProgressNotes: true, readScreeners: true, readAttendance: true,
    });
  });

  it('give the practice manager the business tier only', () => {
    expect(clientAffordances(actor(admin), therapist.id)).toMatchObject({
      setFee: true, readProgressNotes: false, readScreeners: false, readAttendance: true,
    });
  });

  it('cost nothing in the audit log — drawing a button is not an access', async () => {
    clientAffordances(actor(desk), therapist.id);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});
