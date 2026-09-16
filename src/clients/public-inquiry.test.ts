import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR, fixedClock } from '../clock';
import { prisma } from '../db';
import { Conflict } from '../errors';
import { makeUser, resetDb, settings } from '../test/harness';
import { readSource } from '../test/source';
import { runInquiryPurge } from './inquiry';
import { PUBLIC_ACTOR, submitPublicInquiry, submitterKey } from './public-inquiry';

const T0 = '2026-09-09T10:00:00Z';
const clock = fixedClock(T0);

/** A submission that should always be accepted, so a test can vary one field. */
const good = (over: Record<string, unknown> = {}) => ({
  firstName: 'Rosa',
  lastName: 'Delgado',
  email: 'rosa@example.test',
  referralSource: 'search',
  ...over,
});

const ADDRESS = '203.0.113.9';
const send = (over: Record<string, unknown> = {}, address = ADDRESS) =>
  submitPublicInquiry(good(over), { address, clock });

const inquiries = () => prisma.inquiry.findMany({ orderBy: { createdAt: 'asc' } });
const publicAudit = () =>
  prisma.auditEvent.findMany({ where: { actorRole: 'public' }, orderBy: { at: 'asc' } });

beforeEach(async () => {
  await resetDb();
  clock.set(T0);
  await settings({ publicInquiryEnabled: true, publicInquiryPerHour: 3 });
});

describe('the door itself', () => {
  it('is shut unless the practice opened it', async () => {
    await settings({ publicInquiryEnabled: false });
    await expect(send()).rejects.toMatchObject({ code: 'closed' });
    expect(await inquiries()).toHaveLength(0);
  });

  it('records being knocked on while shut, so a flood is visible', async () => {
    await settings({ publicInquiryEnabled: false });
    await expect(send()).rejects.toThrow(Conflict);

    const [row, ...rest] = await publicAudit();
    expect(rest).toHaveLength(0);
    expect(row!).toMatchObject({
      actorId: 'public', actorRole: 'public', action: 'create',
      resource: 'inquiry', allowed: false, reason: 'refused:closed',
    });
  });

  it('writes an open enquiry that nobody took', async () => {
    await send();

    const [inq] = await inquiries();
    expect(inq!).toMatchObject({
      firstName: 'Rosa', lastName: 'Delgado', status: 'open',
      // Nobody took this call. That null is the fact, not a gap.
      takenById: null,
      // Structured fields only: there is nowhere on this form to write a
      // sentence, so there is nothing here for one to have landed in.
      note: null, referralNote: null,
      discardReason: null, discardedAt: null, clientId: null,
    });
  });

  it('is attributed to the public, under the rule that let it through', async () => {
    await send();
    const [row] = await publicAudit();
    expect(row!).toMatchObject({
      actorId: 'public', actorRole: 'public', action: 'create',
      resource: 'inquiry', allowed: true, rule: 'unconditional', breakGlass: false,
    });
    // Ids only, and there is not even a client to name (hard rule 3).
    expect(row!.clientId).toBeNull();
  });

  it('hands the submitter back nothing to hold', async () => {
    expect(await send()).toBeUndefined();
  });
});

describe('what a stranger is allowed to say', () => {
  it.each([
    ['no first name', { firstName: '  ' }],
    ['no last name', { lastName: '' }],
    ['no way to reach them', { email: null, phone: null }],
    ['an address that is not one', { email: 'rosa at example' }],
    ['a phone that is not one', { email: null, phone: 'call me' }],
    ['a referral source outside the enum', { referralSource: 'injected' }],
  ])('refuses %s', async (_label, over) => {
    await expect(send(over)).rejects.toMatchObject({ code: 'invalid' });
    expect(await inquiries()).toHaveLength(0);
  });

  it('takes a phone number on its own', async () => {
    await send({ email: null, phone: '(555) 010-4477' });
    expect(await inquiries()).toHaveLength(1);
  });

  it('trims what it stores rather than refusing over whitespace', async () => {
    await send({ firstName: '  Rosa  ', email: '  rosa@example.test ' });
    const [inq] = await inquiries();
    expect(inq!).toMatchObject({ firstName: 'Rosa', email: 'rosa@example.test' });
  });

  it('bounds every field, so the ceiling is the schema and not the submitter', async () => {
    await send({ firstName: 'a'.repeat(500) });
    const [inq] = await inquiries();
    expect(inq!.firstName).toHaveLength(80);
  });

  it('spends no allowance on a typo', async () => {
    // Validation runs first on purpose: a real person mistyping their email
    // three times must not find the form closed on the fourth attempt.
    for (let i = 0; i < 5; i++) {
      await expect(send({ email: 'nope' })).rejects.toMatchObject({ code: 'invalid' });
    }
    await send();
    expect(await inquiries()).toHaveLength(1);
  });
});

describe('asking for somebody by name', () => {
  it('keeps a clinician they could have read off the website', async () => {
    const t = await makeUser('therapist');
    await send({ requestedClinicianId: t.id });
    expect((await inquiries())[0]?.requestedClinicianId).toBe(t.id);
  });

  it('quietly forgets one who left, rather than losing the enquiry', async () => {
    const gone = await makeUser('therapist');
    await prisma.user.update({ where: { id: gone.id }, data: { active: false } });
    await send({ requestedClinicianId: gone.id });

    const [inq] = await inquiries();
    expect(inq!.requestedClinicianId).toBeNull();
    expect(inq!.firstName).toBe('Rosa');
  });

  it('will not be pointed at somebody who does not see clients', async () => {
    const desk = await makeUser('front_desk');
    await send({ requestedClinicianId: desk.id });
    expect((await inquiries())[0]?.requestedClinicianId).toBeNull();
  });

  it('survives an id that never existed', async () => {
    await send({ requestedClinicianId: 'not-a-real-id' });
    expect(await inquiries()).toHaveLength(1);
  });
});

describe('the hourly ceiling', () => {
  it('accepts up to the practice limit and then stops', async () => {
    for (let i = 0; i < 3; i++) await send();
    await expect(send()).rejects.toMatchObject({ code: 'too_many' });
    expect(await inquiries()).toHaveLength(3);
  });

  it('logs the refusal without saying who was refused', async () => {
    for (let i = 0; i < 3; i++) await send();
    await expect(send()).rejects.toThrow(Conflict);

    const refusal = (await publicAudit()).at(-1);
    expect(refusal).toMatchObject({ allowed: false, reason: 'refused:throttled' });
    // No name, no address, no row — an audit log that leaks is worse than none.
    expect(refusal?.resourceId).toBeNull();
    expect(refusal?.clientId).toBeNull();
  });

  it('reads the limit from the practice, not from a constant', async () => {
    await settings({ publicInquiryPerHour: 1 });
    await send();
    await expect(send()).rejects.toMatchObject({ code: 'too_many' });
  });

  it('opens again once the window has passed', async () => {
    for (let i = 0; i < 3; i++) await send();
    await expect(send()).rejects.toMatchObject({ code: 'too_many' });

    clock.advance(HOUR + 1000);
    await send();
    expect(await inquiries()).toHaveLength(4);
  });

  it('counts each submitter separately', async () => {
    for (let i = 0; i < 3; i++) await send();
    await expect(send()).rejects.toMatchObject({ code: 'too_many' });

    // Somebody else's enquiry is not collateral damage of a flood.
    await send({}, '198.51.100.4');
    expect(await inquiries()).toHaveLength(4);
  });

  it('holds under a burst, not only one request at a time', async () => {
    // Ten at once from one address, which is what a script does. A read-then-write
    // claim let every one of them see an empty window and all ten through.
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => send()));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'too_many' });
    expect(await inquiries()).toHaveLength(3);
  });

  it('never stores the address it counted', async () => {
    await send();
    const [row] = await prisma.inquiryThrottle.findMany();
    expect(row?.id).not.toContain(ADDRESS);
    expect(row?.id).toBe(submitterKey(ADDRESS));
    expect(submitterKey(ADDRESS)).not.toBe(submitterKey('198.51.100.4'));
  });

  it('refuses to key the throttle on a per-instance random secret in production', () => {
    const env = (e: Record<string, string | undefined>) => e as NodeJS.ProcessEnv;
    expect(() => submitterKey(ADDRESS, env({ NODE_ENV: 'production' })))
      .toThrow(/CLEARPATH_THROTTLE_SECRET/);
    expect(() => submitterKey(ADDRESS, env({ CLEARPATH_ALLOW_CLOUD_DB: '1' })))
      .toThrow(/CLEARPATH_THROTTLE_SECRET/);
    expect(submitterKey(ADDRESS, env({ NODE_ENV: 'development' }))).toBe(submitterKey(ADDRESS));
    expect(submitterKey(ADDRESS, env({ NODE_ENV: 'production', CLEARPATH_THROTTLE_SECRET: 'x' })))
      .not.toBe(submitterKey(ADDRESS));
  });

  it('starts the window at the instant the clock gave, whatever zone the session is in', async () => {
    // The claim is raw SQL into a zone-less column, where Prisma is not there to
    // convert. Read back through Prisma, which the purge also compares with.
    await send();
    const [row] = await prisma.inquiryThrottle.findMany();
    expect(row?.windowStartedAt).toEqual(new Date(T0));
  });

  it('lets the purge sweep spent windows away', async () => {
    await send();
    expect(await prisma.inquiryThrottle.count()).toBe(1);

    clock.advance(HOUR + 1000);
    await runInquiryPurge(clock);
    expect(await prisma.inquiryThrottle.count()).toBe(0);
  });
});

describe('the honeypot', () => {
  it('answers a robot with the same silence a person gets, and writes nothing', async () => {
    await expect(send({ website: 'http://buy-things.example' })).resolves.toBeUndefined();
    expect(await inquiries()).toHaveLength(0);

    const [row] = await publicAudit();
    expect(row!).toMatchObject({ allowed: false, reason: 'refused:honeypot' });
  });

  it('charges a robot for the attempt', async () => {
    // Checked after the throttle on purpose: caught first, a bot could hammer
    // the endpoint for ever without the counter ever moving.
    for (let i = 0; i < 3; i++) await send({ website: 'x' });
    await expect(send()).rejects.toMatchObject({ code: 'too_many' });
  });

  it('lets an empty one through, because most browsers send the field', async () => {
    await send({ website: '' });
    expect(await inquiries()).toHaveLength(1);
  });
});

describe('the public actor', () => {
  it('is nobody, and holds one cell', () => {
    expect(PUBLIC_ACTOR).toEqual({ id: 'public', role: 'public' });
  });

  it('is never a user account', async () => {
    await send();
    expect(await prisma.user.count({ where: { role: 'public' } })).toBe(0);
  });
});

describe('the form has no free-text field, and that is the design', () => {
  it('accepts nothing a clinical sentence could land in', async () => {
    // `Inquiry.note` is the PRD's named weak point at the front-desk tier,
    // where a person hears it and types "prefers mornings". On a public form
    // that filter is gone, so the field is not offered — asserted on the
    // source, because the failure mode is a field somebody adds later.
    for (const path of ['src/clients/public-inquiry.ts', 'app/enquire/page.tsx', 'app/enquire/actions.ts']) {
      expect(readSource(path), path).not.toMatch(/<textarea|name="note"|name="referralNote"/);
    }
  });

  it('writes null into both free-text columns whatever it is sent', async () => {
    await submitPublicInquiry(
      { ...good(), note: 'I have been having a very hard time', referralNote: 'x' } as never,
      { address: ADDRESS, clock },
    );
    const [inq] = await inquiries();
    expect(inq!).toMatchObject({ note: null, referralNote: null });
  });
});
