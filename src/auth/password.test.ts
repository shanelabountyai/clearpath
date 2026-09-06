import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  passwordComplaint,
  verifyPassword,
} from './password';

describe('hashing', () => {
  it('never stores the password it was given', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).not.toContain('correct horse battery staple');
    expect(encoded).not.toContain('correct');
  });

  it('salts, so the same password twice is not the same row', async () => {
    const a = await hashPassword('same-password-both-times');
    const b = await hashPassword('same-password-both-times');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-both-times', a)).toBe(true);
    expect(await verifyPassword('same-password-both-times', b)).toBe(true);
  });

  it('names its parameters in the row, so they can be raised later', async () => {
    const encoded = await hashPassword('anything-at-all-here');
    const [scheme, n, r, p] = encoded.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
  });
});

describe('verifying', () => {
  it('accepts the password and refuses everything near it', async () => {
    const encoded = await hashPassword('Stillwater-2026!');
    expect(await verifyPassword('Stillwater-2026!', encoded)).toBe(true);
    expect(await verifyPassword('stillwater-2026!', encoded)).toBe(false);
    expect(await verifyPassword('Stillwater-2026', encoded)).toBe(false);
    expect(await verifyPassword('Stillwater-2026! ', encoded)).toBe(false);
    expect(await verifyPassword('', encoded)).toBe(false);
  });

  /**
   * A hash column that is null, truncated or from some other scheme must decide
   * "no", not throw. A 500 on the login route is an oracle: it tells an
   * attacker which accounts have never set a password.
   */
  it('refuses a malformed or absent hash instead of throwing', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$1$2', 'bcrypt$x$y$z$w', null, undefined]) {
      expect(await verifyPassword('anything', bad as string)).toBe(false);
    }
  });
});

/**
 * The check runs even when there is no user, so that "no such account" and
 * "wrong password" cost the same. Without it the login route enumerates staff
 * by timing alone.
 */
describe('the absent account', () => {
  it('has a hash to verify against, and nothing verifies against it', async () => {
    const { ABSENT_ACCOUNT_HASH } = await import('./password');
    expect(await verifyPassword('', ABSENT_ACCOUNT_HASH)).toBe(false);
    expect(await verifyPassword('password', ABSENT_ACCOUNT_HASH)).toBe(false);
    expect(await verifyPassword(ABSENT_ACCOUNT_HASH, ABSENT_ACCOUNT_HASH)).toBe(false);
  });
});

describe('the complaint a weak password gets', () => {
  it('is a sentence for a short one, and nothing for a good one', () => {
    expect(passwordComplaint('short')).toMatch(/\d+ characters/);
    expect(passwordComplaint('a'.repeat(MIN_PASSWORD_LENGTH - 1))).not.toBeNull();
    expect(passwordComplaint('a-long-enough-passphrase')).toBeNull();
  });

  it('refuses the handful everyone tries first, at any length', () => {
    expect(passwordComplaint('password123456')).not.toBeNull();
    expect(passwordComplaint('Password1234!')).not.toBeNull();
  });

  it('never repeats the password back in the complaint', () => {
    const complaint = passwordComplaint('hunter2');
    expect(complaint).not.toBeNull();
    expect(complaint).not.toContain('hunter2');
  });
});
