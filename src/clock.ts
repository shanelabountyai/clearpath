/**
 * The only source of "now" in the application.
 *
 * The late-cancellation window is a policy with money attached, decided
 * server-side from this clock — never from whoever clicked, and never from a
 * bare `new Date()` scattered through a handler. Tests move time instead of
 * waiting for it.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock frozen at, or advanced from, a fixed instant. */
export function fixedClock(at: Date | string): Clock & { set(d: Date | string): void; advance(ms: number): void } {
  let current = new Date(at);
  return {
    now: () => new Date(current),
    set: (d) => { current = new Date(d); },
    advance: (ms) => { current = new Date(current.getTime() + ms); },
  };
}

const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
