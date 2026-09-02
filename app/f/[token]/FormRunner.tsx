'use client';

import { useState, useTransition } from 'react';
import type { Answers, FieldDef, TemplateSchema } from '../../../src/forms/schema';
import { visibleFields } from '../../../src/forms/schema';
import { saveProgress, submit } from './actions';

/**
 * Conditional questions appear and disappear as the client answers, which is
 * the one place in this project that genuinely needs to run in the browser.
 * The same `visibleFields` the server validates with decides what shows here,
 * so the form cannot ask for something the server would then reject.
 */
export function FormRunner({
  token, schema, initialAnswers,
}: {
  token: string;
  schema: TemplateSchema;
  initialAnswers: Answers;
}) {
  const [answers, setAnswers] = useState<Answers>(initialAnswers);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const fields = visibleFields(schema, answers);
  const set = (key: string, value: unknown) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    setSaved(false);
  };

  // Only answers to questions still on screen are sent. A branch the client
  // opened and then closed must not travel with the submission.
  const payload = () => Object.fromEntries(fields.filter((f) => answers[f.key] !== undefined).map((f) => [f.key, answers[f.key]]));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await submit(token, payload());
          if (result?.error) setError(result.error);
        });
      }}
    >
      <ol className="space-y-6">
        {fields.map((f, i) => (
          <li key={f.key}>
            <Question field={f} index={i + 1} value={answers[f.key]} onChange={(v) => set(f.key, v)} />
          </li>
        ))}
      </ol>

      {error && (
        <p
          role="alert"
          className="mt-6 rounded-[var(--radius)] border px-3 py-2 text-lead"
          style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
        >
          {error}
        </p>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius)] px-5 py-2.5 text-subhead font-medium disabled:opacity-60"
          style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
        >
          {pending ? 'Sending…' : 'Send to the practice'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(async () => { await saveProgress(token, payload()); setSaved(true); })}
          className="rounded-[var(--radius)] border px-4 py-2.5 text-subhead"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          Save and finish later
        </button>
        {saved && <span className="text-body" style={{ color: 'var(--success)' }}>Saved. Your link will bring you back here.</span>}
      </div>
    </form>
  );
}

function Question({
  field, index, value, onChange,
}: {
  field: FieldDef; index: number; value: unknown; onChange: (v: unknown) => void;
}) {
  const id = `q-${field.key}`;
  const label = (
    <label htmlFor={id} className="block text-subhead leading-snug">
      <span className="mr-1.5 font-mono text-caption text-subtle">{index}</span>
      {field.label}
      {field.required && <span aria-hidden className="ml-1" style={{ color: 'var(--danger)' }}>*</span>}
    </label>
  );

  const inputStyle = {
    borderColor: 'var(--border)',
    background: 'var(--surface-raised)',
  } as const;

  if (field.type === 'scale' && field.options) {
    return (
      <fieldset>
        <legend className="mb-2 text-subhead leading-snug">
          <span className="mr-1.5 font-mono text-caption text-subtle">{index}</span>
          {field.label}
        </legend>
        <div className="flex flex-wrap gap-2">
          {field.options.map((o) => {
            const active = value === o.value;
            return (
              <label
                key={String(o.value)}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius)] border px-3 py-2 text-lead"
                style={{
                  borderColor: active ? 'var(--accent)' : 'var(--border)',
                  background: active ? 'var(--accent-soft)' : 'var(--surface-raised)',
                }}
              >
                <input
                  type="radio" name={field.key} checked={active}
                  onChange={() => onChange(o.value)} className="sr-only"
                />
                <span aria-hidden style={{ color: active ? 'var(--accent)' : 'var(--text-subtle)' }}>
                  {active ? '◉' : '○'}
                </span>
                {o.label}
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (field.type === 'single_select' && field.options) {
    return (
      <>
        {label}
        <select
          id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}
          className="mt-2 w-full rounded-[var(--radius)] border px-3 py-2 text-subhead" style={inputStyle}
        >
          <option value="">Choose one…</option>
          {field.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
      </>
    );
  }

  if (field.type === 'boolean') {
    return (
      <fieldset>
        <legend className="mb-2 text-subhead leading-snug">
          <span className="mr-1.5 font-mono text-caption text-subtle">{index}</span>
          {field.label}
        </legend>
        <div className="flex gap-2">
          {[['Yes', true], ['No', false]].map(([text, v]) => (
            <label
              key={String(v)}
              className="flex cursor-pointer items-center gap-2 rounded-[var(--radius)] border px-4 py-2 text-lead"
              style={{
                borderColor: value === v ? 'var(--accent)' : 'var(--border)',
                background: value === v ? 'var(--accent-soft)' : 'var(--surface-raised)',
              }}
            >
              <input type="radio" name={field.key} checked={value === v} onChange={() => onChange(v)} className="sr-only" />
              <span aria-hidden>{value === v ? '◉' : '○'}</span>
              {text as string}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (field.type === 'long_text') {
    return (
      <>
        {label}
        <textarea
          id={id} rows={4} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}
          className="mt-2 w-full rounded-[var(--radius)] border p-3 font-serif text-subhead leading-relaxed"
          style={inputStyle}
        />
      </>
    );
  }

  return (
    <>
      {label}
      <input
        id={id}
        type={field.type === 'date' ? 'date' : 'text'}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-[var(--radius)] border px-3 py-2 text-subhead"
        style={{
          ...inputStyle,
          fontFamily: field.type === 'signature' ? 'var(--font-reading)' : undefined,
          fontSize: field.type === 'signature' ? 18 : undefined,
        }}
      />
    </>
  );
}
