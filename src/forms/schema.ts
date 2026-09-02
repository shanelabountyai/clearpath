/**
 * Form templates are data, so a practice manager can revise an intake without a
 * deploy — and every past submission still renders against the version it was
 * actually answered on. Nothing here reads the "current" template.
 */

type FieldType =
  | 'short_text' | 'long_text' | 'single_select'
  | 'scale' | 'date' | 'boolean' | 'signature';

interface Condition {
  field: string;
  equals?: unknown;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  options?: { value: string | number; label: string }[];
  /** For `scale`: inclusive bounds, e.g. a 0–3 Likert. */
  min?: number;
  max?: number;
  /** Shown only when this holds. A hidden field is neither required nor scored. */
  showIf?: Condition;
}

export interface TemplateSchema {
  fields: FieldDef[];
  /** Shown above the form. Neutral by policy — see the reminder deny-list. */
  intro?: string;
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

interface ValidationError {
  field: string;
  message: string;
}

/** Trust-boundary validation: this runs on a submission from an open link. */
export function validateSubmission(schema: TemplateSchema, answers: Answers): ValidationError[] {
  const errors: ValidationError[] = [];
  const visible = visibleFields(schema, answers);
  const visibleKeys = new Set(visible.map((f) => f.key));

  for (const key of Object.keys(answers)) {
    if (!visibleKeys.has(key)) errors.push({ field: key, message: 'Not a question on this form' });
  }

  for (const f of visible) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) errors.push({ field: f.key, message: 'This question needs an answer' });
      continue;
    }
    switch (f.type) {
      case 'scale': {
        if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push({ field: f.key, message: 'Expected a number' }); break; }
        if (f.min !== undefined && v < f.min) errors.push({ field: f.key, message: `Below ${f.min}` });
        if (f.max !== undefined && v > f.max) errors.push({ field: f.key, message: `Above ${f.max}` });
        break;
      }
      case 'single_select': {
        if (!f.options?.some((o) => o.value === v)) errors.push({ field: f.key, message: 'Not one of the choices' });
        break;
      }
      case 'boolean': {
        if (typeof v !== 'boolean') errors.push({ field: f.key, message: 'Expected yes or no' });
        break;
      }
      case 'date': {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push({ field: f.key, message: 'Expected a date' });
        break;
      }
      default: {
        if (typeof v !== 'string') errors.push({ field: f.key, message: 'Expected text' });
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
