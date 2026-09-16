import Link from 'next/link';
import { getSubmission } from '../../../../src/forms/service';
import { Forbidden } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { localDateOf } from '../../../../src/time';
import { inLanguage, type LocalizedText } from '../../../../src/forms/schema';
import type { Language } from '../../../../src/strings';
import { Badge, Card, LockedPanel, PageHeader, ScreenerResult, TierBanner } from '../../../../src/ui/primitives';

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
                <dt className="text-body">{inLanguage(field.label, STAFF_LANGUAGE)}</dt>
                <dd className="font-serif text-lead sm:text-right">
                  {formatAnswer(field, value)}
                </dd>
              </div>
            ))}
          </dl>

          {s.orphans.length > 0 && (
            <div className="mt-4 rounded-[var(--radius)] border p-3" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-sunken)' }}>
              <p className="text-caption font-medium">Answers to retired questions</p>
              <p className="mt-0.5 text-caption text-muted">
                These were answered on an earlier version of this form. They are kept rather
                than dropped — the client did answer them.
              </p>
              <ul className="mt-1.5 font-mono text-caption text-muted">
                {s.orphans.map((o) => <li key={o.key}>{o.key}: {String(o.value)}</li>)}
              </ul>
            </div>
          )}
        </Card>

        <ScreenerResult
          totalScore={s.totalScore}
          band={s.band}
          needsReview={s.needsReview}
          reviewReasons={s.reviewReasons}
          signatureName={s.signatureName}
          submittedAt={s.submittedAt}
        />
      </div>
    </>
  );
}

/**
 * The record is read in the practice's working language, whatever the client
 * answered in — and that costs nothing, because a submission stores *values*.
 * A Spanish client picking "Varios días" stores `1`, and `1` renders here as
 * "Several days" against the same template version they answered on. One
 * instrument, two readings, no translation at read time and no second
 * template key to fork a client's score history across.
 *
 * The exception is free text, which is the client's own words and stays in
 * them. Machine-translating what somebody wrote about their own life into the
 * clinical record would be a worse answer than a clinician who needs an
 * interpreter knowing that they do.
 */
const STAFF_LANGUAGE: Language = 'en';

function formatAnswer(field: { type: string; options?: { value: string | number; label: LocalizedText }[] }, value: unknown) {
  if (value === null || value === undefined || value === '') return <span className="text-subtle">—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const option = field.options?.find((o) => o.value === value)?.label;
  const label = option && inLanguage(option, STAFF_LANGUAGE);
  if (label) return field.type === 'scale' ? `${label} (${String(value)})` : label;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
