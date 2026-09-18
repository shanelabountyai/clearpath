import Link from 'next/link';
import type { AlertKind } from '../../../src/generated/prisma/enums';
import { myAlerts } from '../../../src/forms/service';
import { requireSession } from '../../../src/session';
import { localDateOf } from '../../../src/time';
import { Badge, Card, EmptyState, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { acknowledge } from './actions';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

/**
 * Reason codes rendered as sentences. The code is what travels through the
 * system; the wording lives here, at the edge, where it is read by exactly one
 * person and never logged.
 */
const REASON_TEXT: Record<string, string> = {
  'critical:item_9': 'A response about thoughts of self-harm was above zero.',
  'threshold:moderate': 'The total score reached the moderate band.',
  'threshold:moderately_severe': 'The total score reached the moderately severe band.',
  'threshold:severe': 'The total score reached the severe band.',
  // P1-3. There is nothing further to render, and that is the whole design:
  // the words were classified once and dropped, so this alert can only ever
  // say that a client wrote — never what they wrote.
  'inbound:unparsed': 'This client replied to a reminder in words. The message was not stored anywhere; please contact them.',
};

/** The chip each kind wears. A third kind is a badge, not another ternary. */
// Keyed by the enum, not by string. With `string` a new alert kind compiled
// cleanly and then threw inside the render (three `!`s on a three-key lookup),
// which took down the one page that holds self-harm flags. Now it is a type
// error in this file instead.
const KIND_BADGE: Record<AlertKind, { tone: 'danger' | 'warning' | 'info'; glyph: string; label: string }> = {
  screener_critical_item: { tone: 'danger', glyph: '◆', label: 'Critical item' },
  screener_threshold: { tone: 'warning', glyph: '▲', label: 'Threshold' },
  inbound_unparsed: { tone: 'info', glyph: '✉', label: 'Client wrote in' },
};

async function AlertsPage() {
  const { actor } = await requireSession();
  const [open, all] = await Promise.all([myAlerts(actor), myAlerts(actor, { includeAcknowledged: true })]);
  const done = all.filter((a) => a.acknowledgedAt);

  return (
    <>
      <PageHeader title="Alerts" subtitle={`${open.length} needing a look`} />

      <div className="mb-4">
        <TierBanner tier="private">
          Addressed to you as the treating clinician. These never reach front desk, a
          supervisor, a shared inbox, or the practice manager.
        </TierBanner>
      </div>

      {open.length === 0 ? (
        <EmptyState title="Nothing outstanding">
          Screener responses that cross a threshold or flag a critical item arrive here, and
          so does a client writing back in words nobody could safely classify.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {open.map((a) => (
            <li key={a.id}>
              <Card className="border-l-4" >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/clients/${a.clientId}`} className="font-medium text-accent hover:underline">
                        {a.client.lastName}, {a.client.firstName}
                      </Link>
                      <span className="font-mono text-caption text-subtle">{a.client.code}</span>
                      <Badge tone={KIND_BADGE[a.kind].tone} glyph={KIND_BADGE[a.kind].glyph}>
                        {KIND_BADGE[a.kind].label}
                      </Badge>
                    </div>
                    <ul className="mt-1.5 space-y-0.5 text-body text-muted">
                      {a.reasons.map((r) => (
                        <li key={r}>{REASON_TEXT[r] ?? r}</li>
                      ))}
                    </ul>
                    <p className="mt-1 text-caption text-subtle">{localDateOf(a.createdAt)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {a.submissionId && (
                      <Link
                        href={`/submissions/${a.submissionId}`}
                        className="rounded-[var(--radius)] px-3 py-1.5 text-caption font-medium"
                        style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                      >
                        Read the response
                      </Link>
                    )}
                    <form action={acknowledge}>
                      <input type="hidden" name="alertId" value={a.id} />
                      <button className="rounded-[var(--radius)] border px-3 py-1.5 text-caption" style={{ borderColor: 'var(--border-strong)' }}>
                        Acknowledge
                      </button>
                    </form>
                  </div>
                </div>
                <p className="mt-3 border-t pt-2 text-caption text-subtle" style={{ borderColor: 'var(--border)' }}>
                  A flag is a prompt to follow up with the client yourself. Clearpath does not
                  contact anyone on your behalf and does not escalate.
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-body text-muted">
            {done.length} acknowledged
          </summary>
          <ul className="mt-2 space-y-1 text-body text-muted">
            {done.map((a) => (
              <li key={a.id}>
                {localDateOf(a.createdAt)} · {a.client.code} · {a.reasons.join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export default withDenial(AlertsPage, {
  title: 'Alerts route to the treating clinician',
  children:
    'A screener crossing a threshold reaches one person: the clinician responsible for that client’s care. There is no shared queue to read.',
});
