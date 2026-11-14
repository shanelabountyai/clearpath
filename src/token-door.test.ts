import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR, fixedClock } from './clock';
import { prisma } from './db';
import { runInquiryPurge } from './clients/inquiry';
import { submitPublicInquiry, submitterKey } from './clients/public-inquiry';
import { resetDb, settings } from './test/harness';
import { readSource, sourceFiles } from './test/source';
import { TOKEN_DOOR_PER_HOUR, claimTokenDoor, tokenDoorKey } from './token-door';

const T0 = '2026-11-13T10:00:00Z';
const clock = fixedClock(T0);
const ADDRESS = '203.0.113.50';
const OPEN = { action: 'read', resource: 'portal_link' } as const;

const claim = (address = ADDRESS) => claimTokenDoor(address, OPEN, clock);
const throttledRows = () =>
  prisma.auditEvent.findMany({ where: { actorRole: 'public', reason: 'refused:throttled' } });

beforeEach(async () => {
  await resetDb();
  clock.set(T0);
});

describe('the token-door ceiling (K5)', () => {
  it('lets an address through up to the hourly ceiling, then refuses on the record', async () => {
    for (let i = 0; i < TOKEN_DOOR_PER_HOUR; i += 1) expect(await claim()).toBe(true);
    expect(await throttledRows()).toHaveLength(0);

    expect(await claim()).toBe(false);
    const [row, ...rest] = await throttledRows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      actorId: 'public', action: 'read', resource: 'portal_link', allowed: false, rule: 'token',
    });
  });

  it('counts each address on its own', async () => {
    for (let i = 0; i < TOKEN_DOOR_PER_HOUR; i += 1) await claim();
    expect(await claim()).toBe(false);
    expect(await claim('198.51.100.7')).toBe(true);
  });

  it('opens again once the hour has passed', async () => {
    for (let i = 0; i < TOKEN_DOOR_PER_HOUR; i += 1) await claim();
    expect(await claim()).toBe(false);
    clock.advance(HOUR + 1000);
    expect(await claim()).toBe(true);
  });

  it('holds under a burst, in the shared table, never storing the address', async () => {
    await prisma.inquiryThrottle.create({
      data: { id: tokenDoorKey(ADDRESS), count: TOKEN_DOOR_PER_HOUR - 3, windowStartedAt: new Date(T0) },
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => claim()));
    expect(results.filter(Boolean)).toHaveLength(3);

    const [row] = await prisma.inquiryThrottle.findMany();
    expect(row?.id).toBe(tokenDoorKey(ADDRESS));
    expect(row?.id).not.toContain(ADDRESS);
  });

  it('does not share a count with the public enquiry form', async () => {
    await settings({ publicInquiryEnabled: true, publicInquiryPerHour: 1 });
    await submitPublicInquiry(
      { firstName: 'Rosa', lastName: 'Delgado', email: 'rosa@example.test', referralSource: 'search' },
      { address: ADDRESS, clock },
    );
    expect(await claim()).toBe(true);
    expect(tokenDoorKey(ADDRESS)).not.toBe(submitterKey(ADDRESS));
    expect(await prisma.inquiryThrottle.count()).toBe(2);
  });

  it('is swept by the same purge as the enquiry throttle', async () => {
    await claim();
    clock.advance(HOUR + 1000);
    await runInquiryPurge(clock);
    expect(await prisma.inquiryThrottle.count()).toBe(0);
  });

  it('stands in front of every token door, page and action alike', () => {
    const doors = sourceFiles().filter((f) => /^app\/(f|p)\/\[token\]\//.test(f) && !f.endsWith('FormRunner.tsx'));
    expect(doors.sort()).toEqual([
      'app/f/[token]/actions.ts', 'app/f/[token]/done/page.tsx', 'app/f/[token]/page.tsx',
      'app/p/[token]/actions.ts', 'app/p/[token]/page.tsx',
    ]);
    for (const f of doors) expect(readSource(f), f).toContain('passTokenDoor(');
    // Each exported action claims before it does anything else.
    for (const f of ['app/f/[token]/actions.ts', 'app/p/[token]/actions.ts']) {
      const src = readSource(f);
      const actions = src.split(/^export async function /m).slice(1);
      expect(actions.length, f).toBeGreaterThan(0);
      for (const body of actions) expect(body, `${f}: ${body.slice(0, 30)}`).toContain('passTokenDoor(');
    }
  });
});
