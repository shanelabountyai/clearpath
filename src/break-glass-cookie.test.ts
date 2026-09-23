import { describe, expect, it } from 'vitest';
import { signBreakGlass, verifyBreakGlass } from './break-glass-cookie';

const env = { CLEARPATH_SESSION_SECRET: 'test-secret' } as unknown as NodeJS.ProcessEnv;
const REASON = 'Client called in crisis, clinician unreachable';

describe('break-glass cookie', () => {
  it('round-trips the reason for the user it was signed for', () => {
    expect(verifyBreakGlass('u1', signBreakGlass('u1', REASON, env), env)).toBe(REASON);
  });

  it('refuses a hand-set, unsigned cookie', () => {
    expect(verifyBreakGlass('u1', REASON, env)).toBeNull();
    expect(verifyBreakGlass('u1', `${Buffer.from(REASON).toString('base64url')}.`, env)).toBeNull();
    expect(verifyBreakGlass('u1', '', env)).toBeNull();
  });

  it('refuses a cookie signed for a different user', () => {
    expect(verifyBreakGlass('u2', signBreakGlass('u1', REASON, env), env)).toBeNull();
  });

  it('refuses a cookie whose reason was swapped after signing', () => {
    const [, sig] = signBreakGlass('u1', REASON, env).split('.');
    expect(verifyBreakGlass('u1', `${Buffer.from('another reason here').toString('base64url')}.${sig}`, env)).toBeNull();
  });

  it('refuses a cookie signed under a different secret', () => {
    const other = { CLEARPATH_SESSION_SECRET: 'other' } as unknown as NodeJS.ProcessEnv;
    expect(verifyBreakGlass('u1', signBreakGlass('u1', REASON, other), env)).toBeNull();
  });

  it('throws in production with no secret rather than signing with a per-process key', () => {
    const prod = { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
    expect(() => signBreakGlass('u1', REASON, prod)).toThrow(/CLEARPATH_SESSION_SECRET/);
    expect(() => verifyBreakGlass('u1', 'a.b', prod)).toThrow(/CLEARPATH_SESSION_SECRET/);
  });
});
