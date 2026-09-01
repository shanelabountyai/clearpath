import { describe, expect, it } from 'vitest';
import { intakeForm, wellbeingCheckIn } from './fixtures.js';
import { renderSubmission, validateSubmission, visibleFields } from './schema.js';
import { scoreSubmission, type ScoringRules } from './scoring.js';

const { schema, scoring } = wellbeingCheckIn;

/** Nine items, in order. Hand-calculated totals below refer to these. */
const answers = (...items: number[]) =>
  Object.fromEntries(items.map((v, i) => [`item_${i + 1}`, v]));

describe('screener totals', () => {
  it('scores an all-zero submission as minimal, with no alert', () => {
    const s = scoreSubmission(schema, scoring, answers(0, 0, 0, 0, 0, 0, 0, 0, 0));
    expect(s.total).toBe(0);
    expect(s.band?.id).toBe('minimal');
    expect(s.needsReview).toBe(false);
  });

  it('sums by hand: 1+2+0+3+1+0+2+1+0 = 10 → moderate, which alerts', () => {
    const s = scoreSubmission(schema, scoring, answers(1, 2, 0, 3, 1, 0, 2, 1, 0));
    expect(s.total).toBe(10);
    expect(s.band?.id).toBe('moderate');
    expect(s.reasons).toEqual(['threshold:moderate']);
    expect(s.needsReview).toBe(true);
  });

  it('sums by hand: 1+1+1+1+1+0+0+0+0 = 5 → mild, which does not alert', () => {
    const s = scoreSubmission(schema, scoring, answers(1, 1, 1, 1, 1, 0, 0, 0, 0));
    expect(s.total).toBe(5);
    expect(s.band?.id).toBe('mild');
    expect(s.needsReview).toBe(false);
  });

  it('takes the highest band whose floor the total reaches', () => {
    expect(scoreSubmission(schema, scoring, answers(3, 3, 3, 3, 3, 3, 3, 0, 0)).band?.id).toBe('severe');
    expect(scoreSubmission(schema, scoring, answers(2, 2, 2, 2, 2, 2, 3, 0, 0)).band?.id).toBe('moderately_severe');
  });

  it('scores each band boundary exactly', () => {
    const at = (n: number) => {
      const items = Array(9).fill(0);
      let left = n;
      for (let i = 0; i < 9 && left > 0; i++) { items[i] = Math.min(3, left); left -= items[i]; }
      return scoreSubmission(schema, scoring, answers(...items));
    };
    expect(at(4).band?.id).toBe('minimal');
    expect(at(5).band?.id).toBe('mild');
    expect(at(9).band?.id).toBe('mild');
    expect(at(10).band?.id).toBe('moderate');
    expect(at(14).band?.id).toBe('moderate');
    expect(at(15).band?.id).toBe('moderately_severe');
    expect(at(20).band?.id).toBe('severe');
  });
});

describe('critical items', () => {
  it('alert on their own, whatever the total says', () => {
    const s = scoreSubmission(schema, scoring, answers(0, 0, 0, 0, 0, 0, 0, 0, 1));
    expect(s.total).toBe(1);
    expect(s.band?.id).toBe('minimal');
    expect(s.reasons).toEqual(['critical:item_9']);
    expect(s.needsReview).toBe(true);
  });

  it('do not fire at the safe answer', () => {
    expect(scoreSubmission(schema, scoring, answers(3, 3, 0, 0, 0, 0, 0, 0, 0)).reasons)
      .not.toContain('critical:item_9');
  });

  it('stack with a threshold rather than replacing it', () => {
    const s = scoreSubmission(schema, scoring, answers(2, 2, 2, 2, 1, 1, 0, 0, 2));
    expect(s.total).toBe(12);
    expect(s.reasons).toEqual(['threshold:moderate', 'critical:item_9']);
  });

  it('match a set of answers as well as a floor', () => {
    const rules: ScoringRules = {
      criticalItems: [{ id: 'housing', field: 'living', in: ['unhoused', 'unsafe'] }],
    };
    const s = { fields: [{ key: 'living', label: 'Where are you staying?', type: 'single_select' as const, options: [
      { value: 'stable', label: 'Somewhere stable' }, { value: 'unhoused', label: 'I do not have housing' },
      { value: 'unsafe', label: 'Somewhere I do not feel safe' }] }] };
    expect(scoreSubmission(s, rules, { living: 'stable' }).reasons).toEqual([]);
    expect(scoreSubmission(s, rules, { living: 'unsafe' }).reasons).toEqual(['critical:housing']);
  });
});

describe('reasons carry codes, never content', () => {
  it('never repeats an answer back', () => {
    const s = scoreSubmission(schema, scoring, {
      ...answers(3, 3, 3, 3, 3, 3, 3, 3, 3),
      anything_else: 'I have been having a very hard time since my brother died',
    });
    expect(JSON.stringify(s.reasons)).not.toContain('brother');
    expect(s.reasons.every((r) => /^(threshold|critical):[a-z0-9_]+$/.test(r))).toBe(true);
  });
});

describe('conditional fields', () => {
  const s = intakeForm.schema;

  it('hides a branch until its parent opens it', () => {
    const keys = (a: Record<string, unknown>) => visibleFields(s, a).map((f) => f.key);
    expect(keys({ prior_therapy: false })).not.toContain('prior_therapy_when');
    expect(keys({ prior_therapy: true })).toContain('prior_therapy_when');
    expect(keys({ referral: 'gp' })).not.toContain('referral_other');
    expect(keys({ referral: 'other' })).toContain('referral_other');
  });

  it('does not require an answer to a question it is not showing', () => {
    const complete = {
      preferred_name: 'Sam', prior_therapy: false, goals: 'Sleep better',
      emergency_contact: 'A friend, 555-0100',
    };
    expect(validateSubmission(s, complete)).toEqual([]);
  });

  it('rejects an answer to a hidden question — the form is a trust boundary', () => {
    const errors = validateSubmission(s, {
      preferred_name: 'Sam', prior_therapy: false, goals: 'x', emergency_contact: 'y',
      prior_therapy_when: 'smuggled in',
    });
    expect(errors).toEqual([{ field: 'prior_therapy_when', message: 'Not a question on this form' }]);
  });

  it('does not score a hidden branch', () => {
    const rules: ScoringRules = { numericFields: ['always', 'sometimes'] };
    const sch = {
      fields: [
        { key: 'gate', label: 'Gate', type: 'boolean' as const },
        { key: 'always', label: 'A', type: 'scale' as const },
        { key: 'sometimes', label: 'B', type: 'scale' as const, showIf: { field: 'gate', equals: true } },
      ],
    };
    expect(scoreSubmission(sch, rules, { gate: false, always: 2, sometimes: 3 }).total).toBe(2);
    expect(scoreSubmission(sch, rules, { gate: true, always: 2, sometimes: 3 }).total).toBe(5);
  });

  it('closes a nested branch when its grandparent closes', () => {
    const sch = {
      fields: [
        { key: 'a', label: 'A', type: 'boolean' as const },
        { key: 'b', label: 'B', type: 'boolean' as const, showIf: { field: 'a', equals: true } },
        { key: 'c', label: 'C', type: 'short_text' as const, showIf: { field: 'b', equals: true } },
      ],
    };
    expect(visibleFields(sch, { a: true, b: true }).map((f) => f.key)).toEqual(['a', 'b', 'c']);
    expect(visibleFields(sch, { a: false, b: true }).map((f) => f.key)).toEqual(['a']);
  });
});

describe('validation', () => {
  it('demands the required answers', () => {
    const errors = validateSubmission(schema, { item_1: 0 });
    expect(errors.map((e) => e.field)).toEqual(['item_2', 'item_3', 'item_4', 'item_5', 'item_6', 'item_7', 'item_8', 'item_9']);
  });

  it('holds a scale to its bounds', () => {
    expect(validateSubmission(schema, { ...answers(0,0,0,0,0,0,0,0,0), item_1: 7 }))
      .toContainEqual({ field: 'item_1', message: 'Above 3' });
    expect(validateSubmission(schema, { ...answers(0,0,0,0,0,0,0,0,0), item_1: -1 }))
      .toContainEqual({ field: 'item_1', message: 'Below 0' });
  });

  it('rejects a choice that is not on the list', () => {
    expect(validateSubmission(schema, { ...answers(0,0,0,0,0,0,0,0,0), difficulty: 'catastrophic' }))
      .toContainEqual({ field: 'difficulty', message: 'Not one of the choices' });
  });
});

describe('a submission renders against the version it was answered on', () => {
  it('keeps answers to questions a later version dropped', () => {
    const v1 = { fields: [
      { key: 'kept', label: 'Still asked', type: 'short_text' as const },
      { key: 'retired', label: 'No longer asked', type: 'short_text' as const },
    ] };
    const v2 = { fields: [{ key: 'kept', label: 'Still asked', type: 'short_text' as const }] };
    const submitted = { kept: 'yes', retired: 'an answer that still happened' };

    const asV1 = renderSubmission(v1, submitted);
    expect(asV1.fields.map((f) => f.field.key)).toEqual(['kept', 'retired']);
    expect(asV1.orphans).toEqual([]);

    // Rendering the same answers against v2 is the mistake this guards against:
    // the answer is not lost, it surfaces as an orphan instead.
    const asV2 = renderSubmission(v2, submitted);
    expect(asV2.fields.map((f) => f.field.key)).toEqual(['kept']);
    expect(asV2.orphans).toEqual([{ key: 'retired', value: 'an answer that still happened' }]);
  });

  it('shows no phantom field for a question added after the fact', () => {
    const v2 = { fields: [
      { key: 'old', label: 'Old', type: 'short_text' as const },
      { key: 'new', label: 'Added in v2', type: 'short_text' as const },
    ] };
    const rendered = renderSubmission(v2, { old: 'answered' });
    expect(rendered.fields.find((f) => f.field.key === 'new')?.value).toBeNull();
  });
});
