import { weekdayOf, WEEKDAYS } from '@/src/time';
import type { Tone } from '@/src/ui/primitives';

export const STATUS_TONE: Record<string, Tone> = { planned: 'warning', executed: 'neutral', cancelled: 'neutral' };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A `@db.Date` is midnight UTC on the day it names: read it as that day, never as an instant. */
export function dayLabel(d: Date) {
  const iso = d.toISOString().slice(0, 10);
  return `${WEEKDAYS[weekdayOf(iso)]} ${iso}`;
}

/**
 * What a refusal says, keyed by `Conflict.code` — the code is all that travels
 * in the URL, and a URL is no place for a name (hard rule 3).
 */
const REFUSAL: Record<string, string> = {
  hour_clash:
    'Nothing moved — not one client. A session being transferred lands on an hour its receiving clinician already holds. Move that session, then execute again.',
  departure_not_ready: 'Nothing moved. This plan still has the unresolved items listed here.',
  already_departing: 'That person already has a departure planned. Withdraw it before recording another.',
  last_day_past: 'A last day is needed, and it cannot be before today.',
  not_on_caseload: 'That client is no longer on this caseload, so there is nothing to decide.',
  receiver_unavailable:
    'The person chosen cannot take this on: they are leaving, have left, or their role cannot hold it.',
  bad_transition: 'This departure has already ended, and a finished plan does not change.',
};

export function Refusal({ code }: { code?: string }) {
  if (!code) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded-[var(--radius)] border px-3 py-2 text-body"
      style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
    >
      {REFUSAL[code] ?? 'That could not be done.'}
    </p>
  );
}

const CONTROL = 'mt-1 w-full rounded-[var(--radius)] border px-2 py-1.5 text-body';
const CONTROL_STYLE = { borderColor: 'var(--border)', background: 'var(--surface)' };

export function Pick({ name, label, options, defaultValue = '', id = name }: {
  name: string; label: string; options: { value: string; label: string }[]; defaultValue?: string; id?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-micro font-medium tracking-wide text-subtle uppercase">{label}</label>
      <select id={id} name={name} defaultValue={defaultValue} className={CONTROL} style={CONTROL_STYLE}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function DateInput({ name, label, min }: { name: string; label: string; min?: string }) {
  return (
    <div>
      <label htmlFor={name} className="block text-micro font-medium tracking-wide text-subtle uppercase">{label}</label>
      <input id={name} name={name} type="date" min={min} required className={CONTROL} style={CONTROL_STYLE} />
    </div>
  );
}
