import { describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import {
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  codeForStep,
  generateSecret,
  otpauthUri,
  stepAt,
  verifyTotp,
} from './totp';

/** The secret RFC 6238 publishes its vectors against: ASCII "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const bytes of [[0], [255], [0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]) {
      const buf = Buffer.from(bytes);
      expect(base32Decode(base32Encode(buf))).toEqual(buf);
    }
  });

  it('is the unpadded RFC 4648 alphabet an authenticator app expects', () => {
    expect(base32Encode(Buffer.from('12345678901234567890', 'ascii')))
      .toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(/^[A-Z2-7]+$/.test(RFC_SECRET)).toBe(true);
  });

  it('reads a secret back whatever case and spacing it was typed in', () => {
    const secret = generateSecret();
    const typed = secret.toLowerCase().replace(/(.{4})/g, '$1 ').trim();
    expect(base32Decode(typed)).toEqual(base32Decode(secret));
  });
});

/**
 * RFC 6238, Appendix B. If these six drift, the implementation has stopped
 * being TOTP and an authenticator app will disagree with it.
 */
describe('RFC 6238 test vectors', () => {
  const VECTORS: [seconds: number, code: string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  for (const [seconds, code] of VECTORS) {
    it(`T=${seconds} produces ${code}`, () => {
      expect(codeForStep(RFC_SECRET, Math.floor(seconds / TOTP_PERIOD_SECONDS))).toBe(code);
    });
  }
});

describe('the step', () => {
  it('advances once per period and not before', () => {
    const at = (iso: string) => stepAt(new Date(iso));
    expect(at('2026-03-01T09:00:00Z')).toBe(at('2026-03-01T09:00:29Z'));
    expect(at('2026-03-01T09:00:30Z')).toBe(at('2026-03-01T09:00:00Z') + 1);
  });
});

describe('verifying a code', () => {
  const clock = fixedClock('2026-03-01T09:00:00Z');
  const secret = generateSecret();
  const now = () => clock.now();
  const current = () => codeForStep(secret, stepAt(now()));

  it('accepts the code showing on the phone right now', () => {
    expect(verifyTotp({ secret, code: current(), at: now() })).toEqual({
      ok: true,
      step: stepAt(now()),
    });
  });

  it('accepts a code typed one step late, because people are slow', () => {
    const code = current();
    const later = new Date(now().getTime() + TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotp({ secret, code, at: later }).ok).toBe(true);
  });

  it('refuses a code two steps stale', () => {
    const code = current();
    const later = new Date(now().getTime() + 3 * TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotp({ secret, code, at: later })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses the wrong code, and every malformed shape, without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '000000 ', null, undefined]) {
      const result = verifyTotp({ secret, code: bad as string, at: now() });
      expect(result.ok).toBe(false);
    }
  });

  it('refuses every code when the account has no secret enrolled', () => {
    expect(verifyTotp({ secret: '', code: '000000', at: now() }).ok).toBe(false);
    expect(verifyTotp({ secret: null, code: current(), at: now() }).ok).toBe(false);
  });

  /**
   * The one property a bare HMAC comparison does not give you. A code read over
   * a shoulder, or lifted from a phished form, is valid for its whole step —
   * so the caller records the step it accepted and this refuses to accept that
   * one, or anything older, ever again.
   */
  it('refuses a code that has already been spent', () => {
    const code = current();
    const first = verifyTotp({ secret, code, at: now() });
    expect(first).toEqual({ ok: true, step: stepAt(now()) });

    const second = verifyTotp({ secret, code, at: now(), afterStep: (first as { step: number }).step });
    expect(second).toEqual({ ok: false, reason: 'replayed' });
  });

  it('refuses a code older than the last one spent, not just equal to it', () => {
    const spent = stepAt(now());
    const stale = codeForStep(secret, spent - 1);
    expect(verifyTotp({ secret, code: stale, at: now(), afterStep: spent }))
      .toEqual({ ok: false, reason: 'replayed' });
  });

  it('still accepts the next step after one is spent', () => {
    const spent = stepAt(now());
    const next = new Date(now().getTime() + TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotp({ secret, code: codeForStep(secret, spent + 1), at: next, afterStep: spent }))
      .toEqual({ ok: true, step: spent + 1 });
  });

  it('does not accept another account\'s code', () => {
    const other = generateSecret();
    expect(verifyTotp({ secret, code: codeForStep(other, stepAt(now())), at: now() }).ok).toBe(false);
  });
});

describe('the enrolment URI', () => {
  const uri = otpauthUri({ secret: RFC_SECRET, account: 'dana@stillwater.test' });

  it('is the otpauth form an authenticator app scans', () => {
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain(`period=${TOTP_PERIOD_SECONDS}`);
  });

  it('names the practice, so a stolen phone shows which building it opens', () => {
    expect(uri).toContain('Clearpath');
  });

  it('escapes the account, so an address with a slash cannot forge a label', () => {
    expect(otpauthUri({ secret: RFC_SECRET, account: 'a/b@x.test' })).not.toContain('a/b');
  });
});

describe('a generated secret', () => {
  it('is 160 bits, which is what the RFC requires and what apps expect', () => {
    expect(base32Decode(generateSecret()).length).toBe(20);
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(seen.size).toBe(50);
  });
});
