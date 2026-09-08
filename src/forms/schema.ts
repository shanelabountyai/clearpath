import { LANGUAGES, type Language } from '../strings';

/**
 * Form templates are data, so a practice manager can revise an intake without a
 * deploy — and every past submission still renders against the version it was
 * actually answered on. Nothing here reads the "current" template.
 */

/**
 * A question, in every language the practice writes in.
 *
 * This is the same rule as the message templates and the deny-list, arriving
 * at a place where the compiler cannot help. `CLIENT_TEMPLATES` is code, so
 * `Record<Language, ...>` makes a missing translation a build failure. A form
 * template is *data* — the whole point is that a practice manager revises one
 * without a deploy — so the type only describes the shape a row ought to have,
 * and nothing stops a row being written without its Spanish.
 *
 * What stops it is `missingLanguages` below, called where the form is *sent*
 * rather than where it is rendered. The practice finds out when it tries to
 * issue the form, not when the client is already looking at a blank question.
 * That is the same choice `assertDiscreet` makes for the same reason: a gate
 * at render time protects nobody, because by then the message has gone.
 */
export type LocalizedText = Record<Language, string>;

/** The one place a localized string is turned back into a single string. */
export const inLanguage = (text: LocalizedText, language: Language): string => text[language];

type FieldType =
  | 'short_text' | 'long_text' | 'single_select'
  | 'scale' | 'date' | 'boolean' | 'signature';

interface Condition {
  field: string;
  equals?: unknown;
}

export interface FieldDef {
  key: string;
  label: LocalizedText;
  type: FieldType;
  required?: boolean;
  help?: LocalizedText;
  options?: { value: string | number; label: LocalizedText }[];
  /** For `scale`: inclusive bounds, e.g. a 0–3 Likert. */
  min?: number;
  max?: number;
  /** Shown only when this holds. A hidden field is neither required nor scored. */
  showIf?: Condition;
}

export interface TemplateSchema {
  fields: FieldDef[];
  /**
   * The heading the client reads. Separate from `FormTemplate.name`, which is
   * the operational label the practice picks the template by and is not
   * client-facing — a staff list and a client's heading are two audiences, and
   * only one of them reads Spanish.
   */
  title?: LocalizedText;
  /** Shown above the form. Neutral by policy — see the reminder deny-list. */
  intro?: LocalizedText;
}

/**
 * Which languages this template cannot yet be sent in, and why it is a list
 * rather than a boolean: a practice manager who added one field in English
 * needs to know it was that field, not that "the form is broken".
 *
 * Only the questions a client could actually see count. A field's `help` is
 * checked with it because it is on the same screen; option labels are checked
 * because an untranslated choice is a question the client cannot answer
 * honestly, which is worse than one they cannot read at all.
 */
export function missingLanguages(schema: TemplateSchema): Record<Language, string[]> {
  const missing = Object.fromEntries(LANGUAGES.map((l) => [l, [] as string[]])) as Record<Language, string[]>;
  const check = (text: LocalizedText | undefined, where: string) => {
    if (!text) return;
    for (const l of LANGUAGES) if (!text[l]?.trim()) missing[l].push(where);
  };
  check(schema.title, 'title');
  check(schema.intro, 'intro');
  for (const f of schema.fields) {
    check(f.label, f.key);
    check(f.help, `${f.key}.help`);
    for (const o of f.options ?? []) check(o.label, `${f.key}.${o.value}`);
  }
  return missing;
}

export type Answers = Record<string, unknown>;

function conditionHolds(cond: Condition, answers: Answers): boolean {
  const value = answers[cond.field];
  if (cond.equals !== undefined) return value === cond.equals;
  return value !== undefined && value !== null && value !== '';
}

/**
 * Which fields the client actually sees, given what they have answered.
 *
 * Resolved by repeated passes rather than a single one, so a field revealed by
 * another conditional field disappears when its parent does. A one-pass filter
 * leaves orphans visible, which is how a form ends up demanding an answer to a
 * question it is no longer showing.
 */
export function visibleFields(schema: TemplateSchema, answers: Answers): FieldDef[] {
  let visible = schema.fields;
  for (let pass = 0; pass < schema.fields.length; pass++) {
    const keys = new Set(visible.map((f) => f.key));
    const next = visible.filter(
      (f) => !f.showIf || (keys.has(f.showIf.field) && conditionHolds(f.showIf, answers)),
    );
    if (next.length === visible.length) return next;
    visible = next;
  }
  return visible;
}

/**
 * A code, not a sentence. These reach a client through the form's error banner,
 * and a client reads in their own language — so the copy lives in `UI.errors`
 * and this stays the reason the copy was chosen.
 */
export type ValidationCode =
  | 'unknown_field' | 'required' | 'not_a_number' | 'below_min' | 'above_max'
  | 'not_an_option' | 'not_a_boolean' | 'not_a_date' | 'not_text';

interface ValidationError {
  field: string;
  code: ValidationCode;
}

/** Trust-boundary validation: this runs on a submission from an open link. */
export function validateSubmission(schema: TemplateSchema, answers: Answers): ValidationError[] {
  const errors: ValidationError[] = [];
  const visible = visibleFields(schema, answers);
  const visibleKeys = new Set(visible.map((f) => f.key));

  for (const key of Object.keys(answers)) {
    if (!visibleKeys.has(key)) errors.push({ field: key, code: 'unknown_field' });
  }

  for (const f of visible) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) errors.push({ field: f.key, code: 'required' });
      continue;
    }
    switch (f.type) {
      case 'scale': {
        if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push({ field: f.key, code: 'not_a_number' }); break; }
        if (f.min !== undefined && v < f.min) errors.push({ field: f.key, code: 'below_min' });
        if (f.max !== undefined && v > f.max) errors.push({ field: f.key, code: 'above_max' });
        break;
      }
      case 'single_select': {
        if (!f.options?.some((o) => o.value === v)) errors.push({ field: f.key, code: 'not_an_option' });
        break;
      }
      case 'boolean': {
        if (typeof v !== 'boolean') errors.push({ field: f.key, code: 'not_a_boolean' });
        break;
      }
      case 'date': {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push({ field: f.key, code: 'not_a_date' });
        break;
      }
      default: {
        if (typeof v !== 'string') errors.push({ field: f.key, code: 'not_text' });
      }
    }
  }
  return errors;
}

/**
 * Render a stored submission against the template version it was answered on.
 * Answers to fields that no longer exist are kept and labelled, rather than
 * dropped: a record that quietly loses answers is worse than one that shows a
 * question the practice has since retired.
 */
export function renderSubmission(schema: TemplateSchema, answers: Answers) {
  const known = new Set(schema.fields.map((f) => f.key));
  return {
    fields: visibleFields(schema, answers).map((f) => ({ field: f, value: answers[f.key] ?? null })),
    orphans: Object.keys(answers)
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, value: answers[k] })),
  };
}
