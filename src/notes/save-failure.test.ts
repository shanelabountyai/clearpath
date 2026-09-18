import { describe, expect, it } from 'vitest';
import { Conflict, Forbidden, NotFound } from '../errors';
import { SAVE_FAILURE_TEXT, saveFailureOf } from './save-failure';

describe('saveFailureOf', () => {
  it('names the refusal without carrying the error across', () => {
    expect(saveFailureOf(new Forbidden('process_note', 'update', true))).toBe('denied');
    expect(saveFailureOf(new NotFound('process_note'))).toBe('denied');
    expect(saveFailureOf(new Conflict('already signed'))).toBe('conflict');
  });

  it('treats anything unrecognised as a plain failure, message and all', () => {
    const leak = new Error('insert failed: content="client said her brother..."');
    expect(saveFailureOf(leak)).toBe('failed');
    expect(saveFailureOf('a string')).toBe('failed');
    expect(Object.values(SAVE_FAILURE_TEXT).join()).not.toContain('brother');
  });
});
