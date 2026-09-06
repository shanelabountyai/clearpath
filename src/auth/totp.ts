import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 time-based one-time passwords.
 *
 * The point of building this rather than declaring the seam is that it can
 * fail, and fails in four distinguishable ways: a wrong code, a stale one, a
 * replayed one, and an account with nothing enrolled. WRITEUP §9 argued that a
 * check which cannot fail is worse than an absent one; this is the answer to
 * that, and the RFC's own test vectors in `totp.test.ts` are what keep it
 * honest — if they drift, a real authenticator app has stopped agreeing with
 * us and the check has quietly become theatre again.
 *
 * SHA-1 and six digits are not a weakness here, they are the interoperability
 * contract: it is what every authenticator app implements, and the security of
 * TOTP rests on the shared secret and the 30-second step, not on the digest.
 *
 * Time arrives as an argument. Hard rule 7 gets this one for free — a spec can
 * watch a code expire by moving the clock rather than by waiting half a minute.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** How many steps either side of now are accepted. One is ±30s of clock skew. */
export const TOTP_DRIFT_STEPS = 1;
const SECRET_BYTES = 20; // 160 bits, the RFC's requirement.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded — the form an authenticator app takes. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Tolerant of how a person types a secret: lower case, spaces, and the `=`
 * padding some apps show. Anything outside the alphabet after that is dropped
 * rather than throwing — this runs on a field a human is copying by eye.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** Which 30-second window an instant falls in. The counter TOTP hashes. */
export function stepAt(at: Date, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / period);
}

/** HOTP over the step, per RFC 4226 §5.3 — the dynamic-truncation offset. */
export function codeForStep(secret: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  // HMAC-SHA1 is always 20 bytes and the offset is masked to 0..15, so these
  // four reads are in range by construction — `readUInt32BE` says that to the
  // type checker as well as to the reader.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export type TotpResult =
  | { ok: true; step: number }
  /**
   * `replayed` is deliberately distinguishable from `mismatch` *inside* this
   * module and deliberately not distinguishable to the person typing — see the
   * challenge screen, which says the same sentence for both. The difference is
   * worth recording in the audit trail, because a replay is somebody using a
   * code they should not have, and that is a different event from a typo.
   */
  | { ok: false; reason: 'mismatch' | 'replayed' | 'malformed' | 'not_enrolled' };

export interface TotpCheck {
  secret: string | null | undefined;
  code: string | null | undefined;
  at: Date;
  /** Accept only steps strictly after this one. The replay defence. */
  afterStep?: number | null;
  window?: number;
}

/**
 * Verify a code, refusing any step already spent.
 *
 * The replay guard is the part a bare HMAC comparison does not give you: a
 * code is valid for its whole 30-second window, so one read over a shoulder or
 * captured by a phishing page works again until it expires. The caller stores
 * the step this returns and passes it back as `afterStep`, which makes every
 * accepted code single-use across the whole account.
 */
export function verifyTotp({ secret, code, at, afterStep, window = TOTP_DRIFT_STEPS }: TotpCheck): TotpResult {
  if (!secret) return { ok: false, reason: 'not_enrolled' };
  if (typeof code !== 'string' || !new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) {
    return { ok: false, reason: 'malformed' };
  }

  const centre = stepAt(at);
  for (let offset = -window; offset <= window; offset++) {
    const step = centre + offset;
    if (step < 0) continue;
    const expected = Buffer.from(codeForStep(secret, step), 'ascii');
    const got = Buffer.from(code, 'ascii');
    if (expected.length === got.length && timingSafeEqual(expected, got)) {
      // Matched — but a step at or before the last one spent is a code being
      // used a second time, which is refused even though the HMAC is correct.
      if (afterStep !== undefined && afterStep !== null && step <= afterStep) {
        return { ok: false, reason: 'replayed' };
      }
      return { ok: true, step };
    }
  }
  return { ok: false, reason: 'mismatch' };
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label carries the practice name so that a phone holding fifteen of these
 * says which building this one opens, and the account is percent-encoded so an
 * address containing a slash cannot forge a second path segment.
 */
export function otpauthUri({ secret, account, issuer = 'Clearpath' }: {
  secret: string;
  account: string;
  issuer?: string;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}
