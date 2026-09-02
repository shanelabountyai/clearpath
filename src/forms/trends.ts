import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { clientTarget } from '../clients/repository';
import { bandFor, type ScoringRules, type Threshold } from './scoring';

/**
 * Screener scores over time, for the clinician treating the client.
 *
 * This is the most ethically loaded surface in the project, so the design is
 * mostly restraint. Three rules, all of them refusals:
 *
 * 1. **A trend belongs to one instrument.** Points are grouped by template key.
 *    A depression total and an anxiety total on the same axis is a chart that
 *    means nothing and looks like it means something.
 *
 * 2. **A scoring revision breaks the line.** Rules version with the template, so
 *    two totals scored under different versions are not the same measurement.
 *    The delta is `null` across a version change rather than a number that
 *    reads as clinical movement and is actually a rules edit.
 *
 * 3. **It reports, it does not conclude.** There is no "improving" or
 *    "deteriorating" flag, no slope, no projection. A number going down is not
 *    a person getting better, and software that says so out loud gets believed.
 *
 * The permission is `form_submission`, which no non-clinical role holds at all:
 * front desk cannot reach it, and neither can the practice manager — this is
 * one of the few surfaces break-glass does not open, because there is no
 * emergency that is answered by a chart of somebody's screener history.
 */

export interface TrendInput {
  submissionId: string;
  at: Date;
  total: number | null;
  /** The template version the answers were scored under. */
  templateVersion: number;
  needsReview: boolean;
}

interface TrendPoint {
  submissionId: string;
  at: Date;
  total: number;
  band: Threshold | null;
  /** Change from the previous point, or null when they are not comparable. */
  delta: number | null;
  /**
   * False when the previous point was scored under a different version of the
   * instrument. The two totals are then different measurements that happen to
   * be numbers.
   */
  comparableToPrevious: boolean;
  /** The band changed since the previous comparable point. */
  bandChanged: boolean;
  needsReview: boolean;
}

export function trendSeries(
  submissions: readonly TrendInput[],
  rules: ScoringRules | null,
): TrendPoint[] {
  const scored = submissions
    .filter((s): s is TrendInput & { total: number } => s.total !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  return scored.map((s, i) => {
    const prev = i > 0 ? scored[i - 1] : undefined;
    const comparable = prev !== undefined && prev.templateVersion === s.templateVersion;
    const band = bandFor(s.total, rules?.thresholds);
    return {
      submissionId: s.submissionId,
      at: s.at,
      total: s.total,
      band,
      delta: comparable && prev ? s.total - prev.total : null,
      comparableToPrevious: comparable,
      bandChanged:
        comparable && prev
          ? bandFor(prev.total, rules?.thresholds)?.id !== band?.id
          : false,
      needsReview: s.needsReview,
    };
  });
}

interface ScreenerTrend {
  templateKey: string;
  name: string;
  points: TrendPoint[];
  /** True when any point sits on a different version of the instrument. */
  spansVersions: boolean;
}

/** Every scored instrument this client has answered, each as its own series. */
export async function screenerTrends(actor: Actor, clientId: string): Promise<ScreenerTrend[]> {
  const target = await clientTarget(clientId);

  return guarded(
    { actor, action: 'read', resource: 'form_submission', clientId, target },
    async (tx) => {
      const submissions = await tx.formSubmission.findMany({
        where: { clientId, template: { kind: 'screener' } },
        // Answers are deliberately not selected. A trend is a list of totals,
        // and reading the responses to draw it would be reaching for content
        // this surface has no use for.
        select: {
          id: true, createdAt: true, totalScore: true, needsReview: true,
          template: { select: { key: true, name: true, version: true, scoring: true } },
        },
        orderBy: { createdAt: 'asc' },
      });

      const byKey = new Map<string, typeof submissions>();
      for (const s of submissions) {
        byKey.set(s.template.key, [...(byKey.get(s.template.key) ?? []), s]);
      }

      return [...byKey.entries()].map(([key, rows]) => {
        // The newest version's thresholds label the whole series; the points
        // carry the version they were scored under, so a reader can see where
        // the instrument changed underneath the line.
        const newest = rows[rows.length - 1]!;
        const points = trendSeries(
          rows.map((r) => ({
            submissionId: r.id,
            at: r.createdAt,
            total: r.totalScore,
            templateVersion: r.template.version,
            needsReview: r.needsReview,
          })),
          (newest.template.scoring as ScoringRules | null) ?? null,
        );
        return {
          templateKey: key,
          name: newest.template.name,
          points,
          spansVersions: new Set(rows.map((r) => r.template.version)).size > 1,
        };
      });
    },
  );
}
