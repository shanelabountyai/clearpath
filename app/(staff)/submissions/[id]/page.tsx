import Link from 'next/link';
import { getSubmission } from '../../../../src/forms/service';
import { Forbidden } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { localDateOf } from '../../../../src/time';
import { Badge, Card, LockedPanel, PageHeader, TierBanner } from '../../../../src/ui/primitives';

export const dynamic = 'force-dynamic';

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireSession();

  let s;
  try {
    s = await getSubmission(actor, id);
  } catch (e) {
    if (e instanceof Forbidden) {
      return (
        <div className="mx-auto max-w-2xl py-8">
          <LockedPanel title="Screener responses are clinical">
            A client&rsquo;s answers and scores are readable by their treating clinician.
            Break-glass reaches demographics and progress notes; it does not reach this.
          </LockedPanel>
        </div>
      );
    }
    throw e;
  }

  return (
    <>
      <PageHeader
        title={s.template.name}
        subtitle={`Answered ${localDateOf(s.submittedAt)} against version ${s.template.version}`}
        actions={s.needsReview ? <Badge tone="danger" glyph="◆">Flagged for review</Badge> : undefined}
      />

      <div className="mb-4">
        <TierBanner tier="clinical" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <Card>
          <dl className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {s.fields.map(({ field, value }) => (
              <div key={field.key} className="grid gap-1 py-2.5 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-4">
                <dt className="text-[13.5px]">{field.label}</dt>
                <dd className="font-serif text-[14px] sm:text-right">
                  {formatAnswer(field, value)}
                </dd>
              </div>
            ))}
          </dl>

          {s.orphans.length > 0 && (
            <div className="mt-4 rounded-[var(--radius)] border p-3" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-sunken)' }}>
              <p className="text-[12.5px] font-medium">Answers to retired questions</p>
              <p className="mt-0.5 text-[12px] text-muted">
                These were answered on an earlier version of this form. They are kept rather
                than dropped — the client did answer them.
              </p>
              <ul className="mt-1.5 font-mono text-[12px] text-muted">
                {s.orphans.map((o) => <li key={o.key}>{o.key}: {String(o.value)}</li>)}
              </ul>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          {s.totalScore !== null && (
            <Card>
              <h2 className="mb-1 font-semibold">Score</h2>
              <p className="font-mono text-3xl">{s.totalScore}</p>
              {s.band && <p className="mt-1 text-[13px] text-muted">{s.band.label} band</p>}
              <p className="mt-3 text-[12px] text-subtle">
                A total is a conversation starter, not a diagnosis, and not a trend to chase.
              </p>
            </Card>
          )}
          {s.needsReview && (
            <Card>
              <h2 className="mb-1 font-semibold">Why this is flagged</h2>
              <ul className="space-y-1 font-mono text-[12px] text-muted">
                {s.reviewReasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
              <p className="mt-2 text-[12px] text-subtle">
                Reason codes are what travel to the alert and the audit log. The answers do not.
              </p>
            </Card>
          )}
          {s.signatureName && (
            <Card>
              <h2 className="mb-1 font-semibold">Signature</h2>
              <p className="font-serif text-[15px]">{s.signatureName}</p>
              <p className="text-[12px] text-subtle">Typed name, {localDateOf(s.submittedAt)}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function formatAnswer(field: { type: string; options?: { value: string | number; label: string }[] }, value: unknown) {
  if (value === null || value === undefined || value === '') return <span className="text-subtle">—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const label = field.options?.find((o) => o.value === value)?.label;
  if (label) return field.type === 'scale' ? `${label} (${String(value)})` : label;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
