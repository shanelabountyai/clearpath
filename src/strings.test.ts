import { describe, expect, it } from 'vitest';
import { LANGUAGES, UI, moneyIn, whenLabel, whenLong } from './strings';
import { indiscreetTerms } from './messaging/outbox';

/**
 * The dictionary is `Record<Language, Strings>`, so a missing key is a build
 * failure and needs no test. What the compiler cannot see is a key that was
 * *copied* rather than translated — the failure mode where a language ships,
 * passes typecheck, and shows English to somebody who does not read it.
 */
describe('every client-facing string is actually translated', () => {
  const flatten = (v: unknown, path: string): [string, string][] => {
    if (typeof v === 'string') return [[path, v]];
    if (typeof v === 'function') return [[path, String((v as (...a: never[]) => string)(...(['X', 24, '$90.00'] as never[])))]];
    if (v && typeof v === 'object') {
      return Object.entries(v).flatMap(([k, x]) => flatten(x, `${path}.${k}`));
    }
    return [];
  };

  /**
   * Words that really are the same in both, listed one by one rather than
   * waved through by a softer assertion. The same discipline the deny-list
   * needs for `crisis` and `trauma`: a genuine coincidence is fine, and it has
   * to be someone's decision rather than a hole the test quietly permits.
   */
  const IDENTICAL_ON_PURPOSE = ['.no'];

  it('shares no wording between English and Spanish', () => {
    const en = new Map(flatten(UI.en, ''));
    const es = new Map(flatten(UI.es, ''));
    expect([...es.keys()].sort()).toEqual([...en.keys()].sort());

    // Interpolated values are the same in both, so compare what surrounds them.
    const identical = [...en.entries()]
      .filter(([k, v]) => es.get(k) === v)
      .map(([k]) => k)
      .filter((k) => !IDENTICAL_ON_PURPOSE.includes(k));
    expect(identical).toEqual([]);
  });

  it('answers for every language, with no empty strings', () => {
    for (const l of LANGUAGES) {
      const blank = flatten(UI[l], '').filter(([, v]) => !v.trim());
      expect(blank, `blank strings in ${l}`).toEqual([]);
    }
  });
});

/**
 * The tab title is the one piece of the portal that shows up somewhere the
 * client did not choose to look — a tab strip, a browser history, a phone
 * handed to somebody else. It is under the same rule as an SMS body, so it is
 * checked against the same deny-list, in every language at once.
 */
describe('the titles a shoulder can read', () => {
  it('never says what kind of practice this is', () => {
    for (const l of LANGUAGES) {
      for (const title of [UI[l].portalTitle, UI[l].formTitle, UI[l].doneTitle]) {
        expect(indiscreetTerms(title), `${l}: ${title}`).toEqual([]);
      }
    }
  });
});

describe('dates and money follow the language', () => {
  // 2026-03-10T19:00:00Z is a Tuesday 3pm in the practice timezone.
  const tuesday = new Date('2026-03-10T19:00:00Z');

  it('names the weekday in the reader’s language', () => {
    expect(whenLabel('en', tuesday)).toContain('Tuesday');
    expect(whenLabel('es', tuesday)).toContain('martes');
    expect(whenLong('es', tuesday)).toContain('2026-03-10');
  });

  it('bills in dollars whichever language it explains them in', () => {
    // es-ES would render euros here. A US practice bills a US client in USD.
    expect(moneyIn('en', 9000)).toBe('$90.00');
    expect(moneyIn('es', 9000)).toContain('90');
    expect(moneyIn('es', 9000)).not.toContain('€');
    expect(moneyIn('es', 9000)).toContain('$');
  });
});
