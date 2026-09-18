'use client';

import { useActionState, type ReactNode } from 'react';
import { UI, type Language } from '../../src/strings';
import { enquire } from './actions';

/**
 * The enquiry form that keeps what was typed when it is refused (PRD 4).
 *
 * A refusal returns the submitted values and the fields refill from them via
 * `defaultValue`, so the same code path works with JavaScript off: Next renders
 * the action's state into the POST response. Nothing typed ever reaches a URL.
 */
export function EnquireForm({
  language,
  clinicians,
}: {
  language: Language;
  clinicians: { id: string; name: string }[];
}) {
  const ui = UI[language];
  const [state, dispatch, pending] = useActionState(enquire, null);
  const v = state?.values;

  return (
    <>
      {state && (
        <p
          className="mt-4 rounded-[var(--radius)] border px-3 py-3 text-body"
          style={{ borderColor: 'var(--danger)' }}
          role="alert"
        >
          {ui.enquireErrors[state.code]}
        </p>
      )}

      <form key={state?.id} action={dispatch} className="mt-6 grid gap-4">
        <input type="hidden" name="lang" value={language} />

        {/*
          The honeypot. Hidden from anybody reading the page and from anybody
          hearing it, out of the tab order, and named nothing a browser autofills
          — a real submitter can neither see it nor be talked into filling it,
          so anything in it came from something that read the HTML.
        */}
        <div className="hidden" aria-hidden="true">
          <label htmlFor="website">Website</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="firstName" label={ui.enquireFirstName}>
            <Input id="firstName" name="firstName" autoComplete="given-name" maxLength={80} required defaultValue={v?.firstName} />
          </Field>
          <Field id="lastName" label={ui.enquireLastName}>
            <Input id="lastName" name="lastName" autoComplete="family-name" maxLength={80} required defaultValue={v?.lastName} />
          </Field>
        </div>

        {/*
          `type="email"` does the ordinary catching in the browser, so a mistyped
          address is a red outline rather than a round trip. The either/or rule
          is the server's alone (PRD 4, Q4): it refuses before spending one of
          this submitter's attempts, and the values come back with the refusal.
        */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="email" label={ui.enquireEmail}>
            <Input id="email" name="email" type="email" autoComplete="email" maxLength={160} defaultValue={v?.email} />
          </Field>
          <Field id="phone" label={ui.enquirePhone}>
            <Input id="phone" name="phone" type="tel" autoComplete="tel" maxLength={40} defaultValue={v?.phone} />
          </Field>
        </div>
        <p className="-mt-2 text-caption text-subtle">{ui.enquireContactHint}</p>

        <Field id="requestedClinicianId" label={ui.enquireClinician}>
          <Select id="requestedClinicianId" name="requestedClinicianId" defaultValue={v?.requestedClinicianId ?? ''}>
            <option value="">{ui.enquireNoPreference}</option>
            {clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>

        <Field id="referralSource" label={ui.enquireHeardHow}>
          <Select id="referralSource" name="referralSource" defaultValue={v?.referralSource ?? 'other'} required>
            {(Object.keys(ui.enquireSources) as (keyof typeof ui.enquireSources)[]).map((k) => (
              <option key={k} value={k}>{ui.enquireSources[k]}</option>
            ))}
          </Select>
        </Field>

        <div>
          <button
            disabled={pending}
            className="rounded-[var(--radius)] border px-4 py-2 text-body font-medium"
            style={{ background: 'var(--accent)', color: 'var(--on-solid)', borderColor: 'var(--accent)' }}
          >
            {ui.enquireSubmit}
          </button>
        </div>
      </form>
    </>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-body font-medium">{label}</label>
      {children}
    </div>
  );
}

const CONTROL =
  'rounded-[var(--radius)] border px-3 py-2 text-body';

const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={CONTROL} style={{ borderColor: 'var(--border)' }} />
);

const Select = (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={CONTROL} style={{ borderColor: 'var(--border)' }} />
);
