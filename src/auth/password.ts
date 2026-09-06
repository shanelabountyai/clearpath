import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password storage for staff accounts.
 *
 * `scrypt` from the standard library rather than argon2 or bcrypt, and the
 * reason is not that it is better — argon2id would be the modern default. It
 * is that this project ships with four runtime dependencies and a native
 * addon for password hashing would be a fifth that has to compile on every
 * machine that clones it. scrypt is memory-hard, it is in Node, and the
 * parameters are written into every row so raising them later is a migration
 * rather than an archaeology problem.
 *
 * Nothing in this file logs, throws with, or returns the plaintext. A stack
 * trace carrying a password is the same class of mistake as PHI in a URL.
 */

/**
 * `promisify(scrypt)` picks the three-argument overload and drops the options,
 * which would silently hash at Node's defaults instead of the parameters this
 * file writes into every row. Wrapping it by hand is what keeps N, r and p
 * meaningful.
 */
const scryptAsync = (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** OWASP's floor for scrypt at r=8, p=1. Named in the row, not assumed. */
const N = 16384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 12;

/**
 * The shapes an attacker tries before they try anything else.
 *
 * Deliberately tiny and deliberately not a dictionary: a real deployment wants
 * a breached-password list, which is a download and a service, not a constant.
 * What this catches is the account whose password is the practice's own name —
 * the one a staff member picks in ten seconds on their first morning, and the
 * one a targeted guess starts with.
 */
const OBVIOUS = [/password/i, /stillwater/i, /clearpath/i, /qwerty/i, /^(.)\1+$/, /12345/];

/**
 * Why this password is refused, or `null` if it is fine.
 *
 * Returns a sentence rather than a boolean because the person typing it has to
 * be told what to do differently, and it never quotes the password back —
 * a complaint that echoes the input is a complaint that ends up in a log.
 */
export function passwordComplaint(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase you can remember beats a short password you cannot.`;
  }
  if (OBVIOUS.some((p) => p.test(plain))) {
    return 'That is one of the first things an attacker guesses. Pick something that is not about this practice.';
  }
  return null;
}

/** `scrypt$N$r$p$salt$hash`, both halves base64. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(plain, salt, KEY_BYTES, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Constant-time comparison against a stored hash.
 *
 * Every failure path returns `false`. A malformed or absent hash is a "no",
 * never a throw: a 500 on the login route would tell an attacker which
 * accounts have no password set, which is precisely the set worth attacking.
 */
export async function verifyPassword(plain: string, encoded: string | null | undefined): Promise<boolean> {
  if (!encoded) return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) return false;

  try {
    const want = Buffer.from(expected, 'base64');
    if (want.length === 0) return false;
    const got = await scryptAsync(plain, Buffer.from(salt, 'base64'), want.length, cost);
    return timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/**
 * A real hash of a passphrase nobody holds.
 *
 * The login route verifies against this when the email matches no account, so
 * that a miss and a wrong password cost the same wall time. Without it the
 * fast path *is* the answer: "no such user" returns in microseconds and
 * "wrong password" takes a full scrypt, and staff emails are enumerable from
 * a stopwatch.
 *
 * Generated at import from random bytes, so it is not a constant anybody can
 * precompute, and no password can ever verify against it.
 */
export const ABSENT_ACCOUNT_HASH = [
  'scrypt', N, R, P,
  randomBytes(SALT_BYTES).toString('base64'),
  randomBytes(KEY_BYTES).toString('base64'),
].join('$');
