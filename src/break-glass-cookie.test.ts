import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HOUR } from './clock';
import { BREAK_GLASS_TTL, signBreakGlass, verifyBreakGlass } from './break-glass-cookie';

const env = { CLEARPATH_SESSION_SECRET: 'test-secret' } as unknown as NodeJS.ProcessEnv;
const REASON = 'client_crisis';
const AT = new Date('2026-09-28T14:00:00Z');
const later = (ms: number) => new Date(AT.getTime() + ms);

describe('break-glass cookie', () => {
  it('round-trips the reason code for the user it was signed for', () => {
    expect(verifyBreakGlass('u1', signBreakGlass('u1', REASON, AT, env), AT, env)).toBe(REASON);
  });

  it('refuses a hand-set, unsigned cookie', () => {
    expect(verifyBreakGlass('u1', REASON, AT, env)).toBeNull();
    expect(verifyBreakGlass('u1', `${REASON}.${AT.getTime()}.`, AT, env)).toBeNull();
    expect(verifyBreakGlass('u1', '', AT, env)).toBeNull();
  });

  it('refuses a cookie signed for a different user', () => {
    expect(verifyBreakGlass('u2', signBreakGlass('u1', REASON, AT, env), AT, env)).toBeNull();
  });

  it('refuses a cookie whose reason was swapped after signing', () => {
    const [, iat, sig] = signBreakGlass('u1', REASON, AT, env).split('.');
    expect(verifyBreakGlass('u1', `safeguarding.${iat}.${sig}`, AT, env)).toBeNull();
  });

  it('refuses a cookie whose issued-at was pushed forward after signing', () => {
    const [code, , sig] = signBreakGlass('u1', REASON, AT, env).split('.');
    expect(verifyBreakGlass('u1', `${code}.${later(2 * HOUR).getTime()}.${sig}`, later(2 * HOUR), env)).toBeNull();
  });

  it('refuses a cookie signed under a different secret', () => {
    const other = { CLEARPATH_SESSION_SECRET: 'other' } as unknown as NodeJS.ProcessEnv;
    expect(verifyBreakGlass('u1', signBreakGlass('u1', REASON, AT, other), AT, env)).toBeNull();
  });

  it('expires: good up to the TTL, refused one millisecond after', () => {
    const cookie = signBreakGlass('u1', REASON, AT, env);
    expect(verifyBreakGlass('u1', cookie, later(BREAK_GLASS_TTL), env)).toBe(REASON);
    expect(verifyBreakGlass('u1', cookie, later(BREAK_GLASS_TTL + 1), env)).toBeNull();
  });

  it('will not sign, and will not honour, anything but a listed code — free text never rides in the cookie', () => {
    const prose = 'Client called in crisis, clinician unreachable';
    expect(() => signBreakGlass('u1', prose, AT, env)).toThrow(/reason code/);
    // Even correctly MACed, an unlisted reason is nobody's break-glass.
    const iat = String(AT.getTime());
    const sig = createHmac('sha256', 'test-secret').update(`u1\nurgent\n${iat}`).digest('base64url');
    expect(verifyBreakGlass('u1', `urgent.${iat}.${sig}`, AT, env)).toBeNull();
  });

  it('throws in production with no secret rather than signing with a per-process key', () => {
    const prod = { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
    expect(() => signBreakGlass('u1', REASON, AT, prod)).toThrow(/CLEARPATH_SESSION_SECRET/);
    expect(() => verifyBreakGlass('u1', 'a.1.b', AT, prod)).toThrow(/CLEARPATH_SESSION_SECRET/);
  });
});
