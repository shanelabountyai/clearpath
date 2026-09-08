import Link from 'next/link';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import type { TemplateSchema } from '../../../src/forms/schema';
import type { ScoringRules } from '../../../src/forms/scoring';
import { LANGUAGES } from '../../../src/strings';
import { Badge, Card, PageHeader } from '../../../src/ui/primitives';
import { publishRevision } from './actions';

export const dynamic = 'force-dynamic';

export default async function FormsPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  await requireSession();
  const { template: selectedId } = await searchParams;

  const templates = await prisma.formTemplate.findMany({
    orderBy: [{ key: 'asc' }, { version: 'desc' }],
    select: {
      id: true, key: true, name: true, kind: true, version: true, schema: true, scoring: true,
      _count: { select: { submissions: true } },
    },
  });

  const latestByKey = new Map<string, (typeof templates)[number]>();
  for (const t of templates) if (!latestByKey.has(t.key)) latestByKey.set(t.key, t);

  const selected = selectedId ? templates.find((t) => t.id === selectedId) : [...latestByKey.values()][0];
  const schema = selected ? (selected.schema as unknown as TemplateSchema) : null;
  const scoring = selected?.scoring ? (selected.scoring as unknown as ScoringRules) : null;

  return (
    <>
      <PageHeader
        title="Forms"
        subtitle="Editing publishes a new version. Past submissions keep the version they were answered on."
      />

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card className="h-fit">
          <h2 className="mb-2 font-semibold">Templates</h2>
          <ul className="space-y-2">
            {[...latestByKey.values()].map((t) => {
              const versions = templates.filter((x) => x.key === t.key);
              return (
                <li key={t.key}>
                  <Link
                    href={`/forms?template=${t.id}`}
                    className="block rounded-[var(--radius)] px-2 py-1.5 text-body hover:bg-[var(--surface-inset)]"
                    style={{ background: selected?.key === t.key ? 'var(--surface-inset)' : undefined }}
                  >
                    <span className="font-medium">{t.name}</span>
                    <span className="block text-micro text-subtle">
                      {t.kind} · v{t.version} · {versions.length} version{versions.length === 1 ? '' : 's'}
                    </span>
                  </Link>
                  {versions.length > 1 && (
                    <ul className="mt-1 ml-2 space-y-0.5">
                      {versions.map((v) => (
                        <li key={v.id}>
                          <Link
                            href={`/forms?template=${v.id}`}
                            className="text-caption text-muted hover:underline"
                            style={{ fontWeight: v.id === selected?.id ? 600 : 400 }}
                          >
                            v{v.version} · {v._count.submissions} submissions
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        {selected && schema && (
          <div className="space-y-4">
            <form action={publishRevision}>
              <input type="hidden" name="templateId" value={selected.id} />
              <Card>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <label htmlFor="name" className="block text-micro font-medium tracking-wide text-subtle uppercase">
                      Form name
                    </label>
                    <input
                      id="name" name="name" defaultValue={selected.name}
                      className="mt-1 rounded-[var(--radius)] border px-2 py-1.5 text-lead font-medium"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                    />
                  </div>
                  <Badge tone="info">version {selected.version} · {selected._count.submissions} submissions</Badge>
                </div>

                {/*
                  Every question is edited as the pair. A blank box is not a
                  convenience left for later — `issueForm` refuses to send a
                  template to a client whose language is missing, so an empty
                  field here is a form that will not go out rather than one that
                  goes out half-readable.
                */}
                <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {schema.fields.map((f) => (
                    <li key={f.key} className="flex flex-wrap items-center gap-3 py-2">
                      <span className="w-40 shrink-0 font-mono text-micro text-subtle">{f.key}</span>
                      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                        {LANGUAGES.map((l) => (
                          <label key={l} className="flex items-center gap-2">
                            <span className="w-6 font-mono text-micro text-subtle uppercase">{l}</span>
                            <input
                              name={`label:${f.key}:${l}`} defaultValue={f.label?.[l] ?? ''}
                              aria-invalid={!f.label?.[l]?.trim() || undefined}
                              className="w-full rounded-[var(--radius)] border px-2 py-1 text-body"
                              style={{
                                borderColor: f.label?.[l]?.trim() ? 'var(--border)' : 'var(--danger)',
                                background: 'var(--surface)',
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <span className="w-24 text-caption text-subtle">{f.type}</span>
                      <label className="flex items-center gap-1 text-caption">
                        <input type="checkbox" name={`required:${f.key}`} defaultChecked={f.required} /> required
                      </label>
                      <label className="flex items-center gap-1 text-caption" style={{ color: 'var(--danger)' }}>
                        <input type="checkbox" name="remove" value={f.key} /> retire
                      </label>
                    </li>
                  ))}
                </ul>

                <fieldset className="mt-4 rounded-[var(--radius)] border p-3" style={{ borderColor: 'var(--border)' }}>
                  <legend className="px-1 text-caption font-medium text-muted">Add a question</legend>
                  <div className="flex flex-wrap items-end gap-2">
                    <input name="newFieldKey" placeholder="key" className="w-32 rounded-[var(--radius)] border px-2 py-1 text-body" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }} />
                    <div className="flex min-w-[240px] flex-1 flex-col gap-1">
                      {LANGUAGES.map((l) => (
                        <input
                          key={l} name={`newFieldLabel:${l}`} placeholder={`Question text (${l})`}
                          className="w-full rounded-[var(--radius)] border px-2 py-1 text-body"
                          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                        />
                      ))}
                    </div>
                    <select name="newFieldType" className="rounded-[var(--radius)] border px-2 py-1 text-body" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                      {['short_text', 'long_text', 'boolean', 'date'].map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </fieldset>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button className="rounded-[var(--radius)] px-3 py-1.5 text-body font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
                    Publish as version {selected.version + 1}
                  </button>
                  <span className="text-caption text-subtle">
                    Retiring a question does not delete answers to it. They render as
                    &ldquo;answers to retired questions&rdquo; on the submissions that have them.
                  </span>
                </div>
              </Card>
            </form>

            {scoring && (
              <Card>
                <h2 className="mb-2 font-semibold">Scoring</h2>
                <p className="mb-3 text-body text-muted">
                  Scoring rules version with the template, so a response is always scored by
                  the rules that were in force when it was answered.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <h3 className="text-caption font-medium tracking-wide text-subtle uppercase">Bands</h3>
                    <ul className="mt-1 space-y-1 text-body">
                      {scoring.thresholds?.map((t) => (
                        <li key={t.id} className="flex items-center justify-between">
                          <span>{t.label} <span className="text-subtle">({t.min}+)</span></span>
                          {t.alert && <Badge tone="warning" glyph="▲">alerts</Badge>}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-caption font-medium tracking-wide text-subtle uppercase">Critical items</h3>
                    <ul className="mt-1 space-y-1 text-body">
                      {scoring.criticalItems?.map((c) => (
                        <li key={c.id} className="flex items-center justify-between">
                          <span className="font-mono text-caption">{c.field}</span>
                          <Badge tone="danger" glyph="◆">
                            {c.gte !== undefined ? `≥ ${c.gte}` : `one of ${c.in?.join(', ')}`}
                          </Badge>
                        </li>
                      ))}
                      {!scoring.criticalItems?.length && <li className="text-subtle">None</li>}
                    </ul>
                    <p className="mt-2 text-caption text-subtle">
                      A critical item alerts on its own, whatever the total says.
                    </p>
                  </div>
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
