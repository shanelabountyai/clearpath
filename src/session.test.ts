import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { isSwitchable, openBreakGlass } from './session';
import { verifyBreakGlass } from './break-glass-cookie';
import { fixedClock } from './clock';
import { makeUser, resetDb } from './test/harness';

describe('isSwitchable (SEC-03)', () => {
  beforeEach(resetDb);

  it('accepts anyone the picker offers', async () => {
    for (const role of ['front_desk', 'therapist', 'associate', 'supervisor', 'admin', 'auditor'] as const) {
      expect(await isSwitchable((await makeUser(role)).id), role).toBe(true);
    }
  });

  it('refuses a client-role user, which the picker never lists', async () => {
    expect(await isSwitchable((await makeUser('client')).id)).toBe(false);
  });

  it('refuses a deactivated user, an unknown id and an empty one', async () => {
    const gone = await makeUser('therapist');
    await prisma.user.update({ where: { id: gone.id }, data: { active: false } });
    expect(await isSwitchable(gone.id)).toBe(false);
    expect(await isSwitchable('no-such-user')).toBe(false);
    expect(await isSwitchable('')).toBe(false);
  });
});

describe('openBreakGlass (review #2)', () => {
  beforeEach(resetDb);
  const env = { CLEARPATH_SESSION_SECRET: 'test-secret' } as unknown as NodeJS.ProcessEnv;
  const clock = fixedClock('2026-09-28T14:00:00Z');

  it('refuses free text: no cookie and nothing in the audit log', async () => {
    const pm = await makeUser('admin');
    const prose = 'client called the practice in distress, clinician on leave';
    expect(await openBreakGlass({ id: pm.id, role: pm.role }, prose, clock, env)).toBeNull();
    expect(await openBreakGlass({ id: pm.id, role: pm.role }, '', clock, env)).toBeNull();
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it('logs the code, flagged, then hands back a cookie that verifies to that code', async () => {
    const pm = await makeUser('admin');
    const cookie = await openBreakGlass({ id: pm.id, role: pm.role }, ' client_crisis ', clock, env);

    const rows = await prisma.auditEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: pm.id, breakGlass: true, rule: 'breakGlass', reason: 'client_crisis' });
    expect(verifyBreakGlass(pm.id, cookie!, clock.now(), env)).toBe('client_crisis');
  });
});
