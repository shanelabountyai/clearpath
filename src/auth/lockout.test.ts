import { describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import { FREE_ATTEMPTS, MAX_LOCKOUT_MS, lockoutUntil, lockoutRemaining } from './lockout';

const AT = new Date('2026-03-01T09:00:00Z');

describe('the free attempts', () => {
  it('cost nothing, because people mistype their own password', () => {
    for (let n = 1; n <= FREE_ATTEMPTS; n++) {
      expect(lockoutUntil(n, AT)).toBeNull();
    }
  });

  it('run out', () => {
    expect(lockoutUntil(FREE_ATTEMPTS + 1, AT)).not.toBeNull();
  });
});

describe('the escalation', () => {
  const after = (n: number) => lockoutUntil(n, AT)!.getTime() - AT.getTime();

  it('doubles, so a guessing run gets expensive fast', () => {
    expect(after(FREE_ATTEMPTS + 2)).toBe(after(FREE_ATTEMPTS + 1) * 2);
    expect(after(FREE_ATTEMPTS + 3)).toBe(after(FREE_ATTEMPTS + 1) * 4);
  });

  /**
   * The cap is the whole argument. An account that locks permanently on failed
   * attempts is a denial-of-service weapon that anyone holding a staff email
   * can fire, and the target is a clinician who needs a progress note at 9am.
   * The attacker's cost is bounded either way — at fifteen minutes a window
   * they are down to a handful of guesses an hour — and the practice's cost is
   * bounded too, which a permanent lock does not do.
   */
  it('caps, and never becomes permanent however many times they try', () => {
    for (const n of [20, 200, 20_000]) {
      expect(after(n)).toBe(MAX_LOCKOUT_MS);
      expect(lockoutUntil(n, AT)).toBeInstanceOf(Date);
    }
  });
});

describe('what remains of a lock', () => {
  const clock = fixedClock(AT);

  it('is nothing when there is no lock at all', () => {
    expect(lockoutRemaining(null, clock.now())).toBe(0);
  });

  it('counts down, and reaches zero on its own', () => {
    const until = new Date(AT.getTime() + 60_000);
    expect(lockoutRemaining(until, AT)).toBe(60_000);
    expect(lockoutRemaining(until, new Date(AT.getTime() + 59_000))).toBe(1_000);
    expect(lockoutRemaining(until, until)).toBe(0);
    expect(lockoutRemaining(until, new Date(AT.getTime() + 10 * 60_000))).toBe(0);
  });

  it('is never negative, so a stale lock cannot read as a long one', () => {
    expect(lockoutRemaining(new Date(AT.getTime() - 86_400_000), AT)).toBe(0);
  });
});
