import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock, DAY } from './clock';

describe('fixedClock', () => {
  it('does not move on its own, and moves exactly when told', () => {
    const clock = fixedClock('2026-03-01T09:00:00Z');
    expect(clock.now().toISOString()).toBe(clock.now().toISOString());
    clock.advance(DAY);
    expect(clock.now().toISOString()).toBe('2026-03-02T09:00:00.000Z');
    clock.set('2026-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('hands out copies, so a caller cannot mutate the clock', () => {
    const clock = fixedClock('2026-03-01T09:00:00Z');
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

/**
 * The late-cancel window is policy with money attached, so "now" has exactly
 * one source. A bare `new Date()` anywhere else is a window that cannot be
 * tested without waiting for it.
 */
it('nothing outside clock.ts reads wall time directly', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path === 'src/clock.ts' || path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      if (/new Date\(\s*\)/.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});

it('systemClock is the seam, and it reads the real clock', () => {
  expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
});
