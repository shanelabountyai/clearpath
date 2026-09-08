import { describe, expect, it } from 'vitest';
import { consentToTreat, intakeForm, TEMPLATES, wellbeingCheckIn } from './fixtures';
import { missingLanguages, renderSubmission, validateSubmission, visibleFields, type LocalizedText } from './schema';
import { LANGUAGES } from '../strings';
import { scoreSubmission, type ScoringRules } from './scoring';

const { schema, scoring } = wellbeingCheckIn;

/**
 * Scoring never reads a label — it reads keys and values — so the fixtures
 * below say the same thing in both languages on purpose. A test that had to
 * invent Spanish to exercise a total would be testing the wrong thing.
 */
const anyLanguage = (text: string): LocalizedText => ({ en: text, es: text });

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
    const s = { fields: [{ key: 'living', label: anyLanguage('Where are you staying?'), type: 'single_select' as const, options: [
      { value: 'stable', label: anyLanguage('Somewhere stable') }, { value: 'unhoused', label: anyLanguage('I do not have housing') },
      { value: 'unsafe', label: anyLanguage('Somewhere I do not feel safe') }] }] };
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
    expect(errors).toEqual([{ field: 'prior_therapy_when', code: 'unknown_field' }]);
  });

  it('does not score a hidden branch', () => {
    const rules: ScoringRules = { numericFields: ['always', 'sometimes'] };
    const sch = {
      fields: [
        { key: 'gate', label: anyLanguage('Gate'), type: 'boolean' as const },
        { key: 'always', label: anyLanguage('A'), type: 'scale' as const },
        { key: 'sometimes', label: anyLanguage('B'), type: 'scale' as const, showIf: { field: 'gate', equals: true } },
      ],
    };
    expect(scoreSubmission(sch, rules, { gate: false, always: 2, sometimes: 3 }).total).toBe(2);
    expect(scoreSubmission(sch, rules, { gate: true, always: 2, sometimes: 3 }).total).toBe(5);
  });

  it('closes a nested branch when its grandparent closes', () => {
    const sch = {
      fields: [
        { key: 'a', label: anyLanguage('A'), type: 'boolean' as const },
        { key: 'b', label: anyLanguage('B'), type: 'boolean' as const, showIf: { field: 'a', equals: true } },
        { key: 'c', label: anyLanguage('C'), type: 'short_text' as const, showIf: { field: 'b', equals: true } },
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
      .toContainEqual({ field: 'item_1', code: 'above_max' });
    expect(validateSubmission(schema, { ...answers(0,0,0,0,0,0,0,0,0), item_1: -1 }))
      .toContainEqual({ field: 'item_1', code: 'below_min' });
  });

  it('rejects a choice that is not on the list', () => {
    expect(validateSubmission(schema, { ...answers(0,0,0,0,0,0,0,0,0), difficulty: 'catastrophic' }))
      .toContainEqual({ field: 'difficulty', code: 'not_an_option' });
  });
});

describe('a submission renders against the version it was answered on', () => {
  it('keeps answers to questions a later version dropped', () => {
    const v1 = { fields: [
      { key: 'kept', label: anyLanguage('Still asked'), type: 'short_text' as const },
      { key: 'retired', label: anyLanguage('No longer asked'), type: 'short_text' as const },
    ] };
    const v2 = { fields: [{ key: 'kept', label: anyLanguage('Still asked'), type: 'short_text' as const }] };
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
      { key: 'old', label: anyLanguage('Old'), type: 'short_text' as const },
      { key: 'new', label: anyLanguage('Added in v2'), type: 'short_text' as const },
    ] };
    const rendered = renderSubmission(v2, { old: 'answered' });
    expect(rendered.fields.find((f) => f.field.key === 'new')?.value).toBeNull();
  });
});


/**
 * The instruments the practice actually ships. `missingLanguages` is what the
 * send gate consults, so pointing it at the fixtures is the same check the
 * practice's own forms have to pass before anyone can be sent one.
 */
describe('the shipped instruments are written in every language', () => {
  it.each(TEMPLATES.map((t) => [t.key, t.schema] as const))('%s', (_key, schema) => {
    for (const l of LANGUAGES) {
      expect(missingLanguages(schema)[l]).toEqual([]);
    }
  });

  it('scores identically whichever language the client answered in', () => {
    // The point of one template version serving both: the answer is a value.
    const { schema: s, scoring: rules } = wellbeingCheckIn;
    expect(scoreSubmission(s, rules, answers(3, 3, 3, 0, 0, 0, 0, 0, 0)).total).toBe(9);
    // A Spanish client picking "Casi todos los días" stores 3, exactly as an
    // English client picking "Nearly every day" does — so there is nothing
    // language-shaped left for scoring to get wrong.
    const es = s.fields[0]?.options?.find((o) => o.value === 3);
    expect(es?.label.es).toBe('Casi todos los días');
    expect(es?.label.en).toBe('Nearly every day');
  });

  it('says the cancellation policy in both, because that is the one being signed', () => {
    const field = consentToTreat.schema.fields.find((f) => f.key === 'cancellation_policy');
    expect(field?.label.en).toContain('24-hour');
    expect(field?.label.es).toContain('24 horas');
  });
});
