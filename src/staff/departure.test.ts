import { describe, expect, it } from 'vitest';
import { Conflict } from '../errors';
import {
  TRANSITIONS, assertTransition, canTransition,
  type DepartureStatus,
} from './departure';

const STATUSES = Object.keys(TRANSITIONS) as DepartureStatus[];

describe('the departure state machine', () => {
  it('goes from a plan to exactly two endings', () => {
    expect(canTransition('planned', 'executed')).toBe(true);
    expect(canTransition('planned', 'cancelled')).toBe(true);
  });

  it('has no way back to planned, from either ending', () => {
    expect(canTransition('executed', 'planned')).toBe(false);
    expect(canTransition('cancelled', 'planned')).toBe(false);
  });

  it('cannot cancel a departure that already happened, or execute a cancelled one', () => {
    expect(canTransition('executed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'executed')).toBe(false);
  });

  it('does not let a status become itself — a re-plan is a new row', () => {
    for (const s of STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('refuses every illegal transition with a Conflict, never a silent no-op', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (canTransition(from, to)) {
          expect(() => assertTransition(from, to)).not.toThrow();
          continue;
        }
        expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(Conflict);
      }
    }
  });

  it('names the refusal with the same code the session lifecycle uses', () => {
    try {
      assertTransition('executed', 'cancelled');
      expect.unreachable();
    } catch (e) {
      expect((e as Conflict).code).toBe('bad_transition');
      // No PHI, no names: the message says what a status did, and nothing else.
      expect((e as Conflict).message).toBe('A executed departure cannot become cancelled');
    }
  });
});
