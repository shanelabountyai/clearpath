import { describe, expect, it } from 'vitest';
import { Conflict } from '../errors';
import { assertTransition, canTransition, TRANSITIONS, type InquiryStatus } from './inquiry';

const STATUSES: InquiryStatus[] = ['open', 'converted', 'discarded'];

describe('the inquiry state machine (pure)', () => {
  it('opens, and then goes one of two ways', () => {
    expect(canTransition('open', 'converted')).toBe(true);
    expect(canTransition('open', 'discarded')).toBe(true);
  });

  it('treats both endings as terminal', () => {
    expect(TRANSITIONS.converted).toEqual([]);
    expect(TRANSITIONS.discarded).toEqual([]);
  });

  it('never returns to open, and never crosses between the endings', () => {
    for (const from of ['converted', 'discarded'] as InquiryStatus[]) {
      for (const to of STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('refuses to stay where it is', () => {
    for (const s of STATUSES) expect(canTransition(s, s), s).toBe(false);
  });

  it('raises Conflict on every illegal transition, and only those', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (canTransition(from, to)) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(Conflict);
        }
      }
    }
  });

  it('names no person in the refusal — the message reaches an API response', () => {
    try {
      assertTransition('discarded', 'converted');
    } catch (e) {
      expect((e as Conflict).message).toBe('A discarded inquiry cannot become converted');
      expect((e as Conflict).code).toBe('bad_transition');
    }
  });
});
