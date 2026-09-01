import type { Answers, TemplateSchema } from './schema.js';
import { visibleFields } from './schema.js';

/**
 * Screener scoring.
 *
 * Rules version with the template, so a v1 submission is always scored by v1
 * rules — re-scoring history against a revised instrument would silently
 * rewrite clinical records.
 *
 * Two independent paths to review, and this is the part that matters: a total
 * crossing a threshold, and a **critical item** flagged regardless of total.
 * Someone can answer every other question at zero and still need a call today.
 */

export interface Threshold {
  id: string;
  /** Inclusive lower bound of the band. */
  min: number;
  label: string;
  /** Bands above the practice's concern line alert the treating clinician. */
  alert?: boolean;
}

export interface CriticalItem {
  id: string;
  field: string;
  /** Flag when the answer is at least this, or is one of these. */
  gte?: number;
  in?: (string | number | boolean)[];
}

export interface ScoringRules {
  /** field key → answer value → points. */
  values?: Record<string, Record<string, number>>;
  /** Fields whose numeric answer is itself the score. */
  numericFields?: string[];
  thresholds?: Threshold[];
  criticalItems?: CriticalItem[];
}

export interface Score {
  total: number;
  band: Threshold | null;
  /**
   * Rule identifiers, never answers. These strings travel to the alert, the
   * review queue and the audit log, so anything readable here is effectively
   * published to every surface that shows a flag.
   */
  reasons: string[];
  needsReview: boolean;
}

const points = (rules: ScoringRules, field: string, value: unknown): number => {
  if (rules.numericFields?.includes(field)) return typeof value === 'number' ? value : 0;
  const map = rules.values?.[field];
  if (!map) return 0;
  return map[String(value)] ?? 0;
};

function flags(item: CriticalItem, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (item.gte !== undefined && typeof value === 'number' && value >= item.gte) return true;
  if (item.in !== undefined) {
    const list = Array.isArray(value) ? value : [value];
    return list.some((v) => item.in!.includes(v as string | number | boolean));
  }
  return false;
}

export function scoreSubmission(
  schema: TemplateSchema,
  rules: ScoringRules | null | undefined,
  answers: Answers,
): Score {
  if (!rules) return { total: 0, band: null, reasons: [], needsReview: false };

  // Only what the client was actually shown counts. A hidden branch left over
  // from an earlier answer must not inflate a risk score.
  const visible = visibleFields(schema, answers);

  let total = 0;
  for (const f of visible) {
    const v = answers[f.key];
    if (Array.isArray(v)) for (const item of v) total += points(rules, f.key, item);
    else total += points(rules, f.key, v);
  }

  const bands = [...(rules.thresholds ?? [])].sort((a, b) => b.min - a.min);
  const band = bands.find((t) => total >= t.min) ?? null;

  const reasons: string[] = [];
  if (band?.alert) reasons.push(`threshold:${band.id}`);
  for (const item of rules.criticalItems ?? []) {
    if (!visible.some((f) => f.key === item.field)) continue;
    if (flags(item, answers[item.field])) reasons.push(`critical:${item.id}`);
  }

  return { total, band, reasons, needsReview: reasons.length > 0 };
}
