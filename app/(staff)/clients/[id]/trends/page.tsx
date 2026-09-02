import Link from 'next/link';
import { screenerTrends } from '../../../../../src/forms/trends';
import { Forbidden } from '../../../../../src/errors';
import { requireSession } from '../../../../../src/session';
import { localDateOf } from '../../../../../src/time';
import {
  Badge, Card, EmptyState, LockedPanel, PageHeader, TierBanner,
} from '../../../../../src/ui/primitives';

export const dynamic = 'force-dynamic';

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/**
 * Screener history, on its own page on purpose.
 *
 * A chart of somebody's scores over time is not something to meet while
 * scrolling a record for their phone number. It is a deliberate clinical
 * question, so it is a deliberate navigation, and the read is logged as one.
 */
export default async function TrendsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireSession();

  let trends;
  try {
    trends = await screenerTrends(actor, id);
  } catch (e) {
    if (e instanceof Forbidden) {
      return (
        <div className="mx-auto max-w-2xl py-8">
          <LockedPanel title="Screener responses are clinical" >
            Scores and their history belong to the treating clinician and their supervisor.
          </LockedPanel>
        </div>
      );
    }
    throw e;
  }

  return (
    <>
      <PageHeader
        title="Screeners over time"
        subtitle={
          <Link href={`/clients/${id}`} className="text-accent hover:underline">back to the record</Link>
        }
      />

      <div className="mx-auto max-w-2xl space-y-4">
        <TierBanner tier="clinical">
          Totals and bands only. This page draws no conclusion — a number moving is
          not a person improving, and reading it as one is the mistake it exists to
          make easy.
        </TierBanner>

        {trends.length === 0 && (
          <EmptyState title="No scored screeners yet">
            A trend needs at least one submitted, scored instrument.
          </EmptyState>
        )}

        {trends.map((trend) => (
          <Card key={trend.templateKey}>
            <h2 className="mb-2 font-semibold">{trend.name}</h2>

            <ul className="space-y-1.5 text-body">
              {trend.points.map((p, i) => (
                <li key={p.submissionId} className="flex items-center justify-between gap-2">
                  <Link href={`/submissions/${p.submissionId}`} className="text-accent hover:underline">
                    {localDateOf(p.at)}
                  </Link>
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{p.total}</span>
                    {p.band && <span className="text-caption text-subtle">{p.band.label}</span>}
                    {p.delta !== null && (
                      <span className="font-mono text-caption text-muted">{signed(p.delta)}</span>
                    )}
                    {i > 0 && !p.comparableToPrevious && (
                      <Badge tone="info">revised instrument</Badge>
                    )}
                    {p.needsReview && <Badge tone="danger" glyph="◆">Review</Badge>}
                  </span>
                </li>
              ))}
            </ul>

            {trend.spansVersions && (
              <p className="mt-3 border-t pt-2 text-caption text-subtle" style={{ borderColor: 'var(--border)' }}>
                This instrument was revised during the period shown. Totals either
                side of a revision were produced by different scoring rules and are
                not comparable, so no change is calculated across it.
              </p>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
