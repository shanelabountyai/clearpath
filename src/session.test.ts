import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { isSwitchable } from './session';
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
