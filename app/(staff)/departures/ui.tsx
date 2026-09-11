import { redirect } from 'next/navigation';
import { Conflict } from '@/src/errors';
import { weekdayOf, WEEKDAYS } from '@/src/time';
import type { Tone } from '@/src/ui/primitives';

/**
 * The plan screens' shared parts — a departure's and a leave's.
 *
 * Run one act, or come back to `path` saying why not. Only a `Conflict`'s code
 * travels: it is the whole vocabulary the page renders. A denial is not caught
 * — every control on these pages is drawn from the matrix that would refuse
 * it, so a `Forbidden` here is a hand-rolled POST, and it is on the record
 * either way. Here and not in an actions file, where every export is a
 * callable endpoint.
 */
export async function orBack<T>(path: string, act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (e) {
    if (e instanceof Conflict) redirect(`${path}?error=${e.code ?? 'conflict'}`);
    throw e;
  }
}

export const STATUS_TONE: Record<string, Tone> = { planned: 'warning', executed: 'neutral', cancelled: 'neutral' };
export const PHASE_TONE: Record<string, Tone> = { upcoming: 'warning', active: 'accent', ended: 'neutral', cancelled: 'neutral' };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A `@db.Date` is midnight UTC on the day it names: read it as that day, never as an instant. */
export function dayLabel(d: Date | string) {
  const iso = typeof d === 'string' ? d : d.toISOString().slice(0, 10);
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
  before_last_day:
    'Nothing moved. A departure executes on its last day, not before — until then the caseload is still theirs to work.',
  already_departing: 'That person already has a departure planned. Withdraw it before recording another.',
  last_day_past: 'A last day is needed, and it cannot be before today.',
  not_on_caseload: 'That client is no longer on this caseload, so there is nothing to decide.',
  receiver_unavailable:
    'The person chosen cannot take this on: they are leaving, have left, or their role cannot hold it.',
  bad_transition: 'This departure has already ended, and a finished plan does not change.',
  leave_open: 'Nothing moved. This person has a leave that has not ended. End it early or cancel it, then execute again.',
};

export const LEAVE_REFUSAL: Record<string, string> = {
  leave_overlaps: 'This person already has a leave on some of those days. Move that one, or choose other dates.',
  leave_starts_past:
    'A leave cannot start before today. Its days are the days a colleague may open this caseload, and nobody could have opened it last week.',
  leave_ends_before_start: 'The last day away cannot come before the first. A leave that started today runs at least to midnight.',
  leave_ends_past: 'A leave can end yesterday at the earliest, for somebody back today.',
  leave_started: 'This leave is under way, so its first day stays. The last day can still move.',
  leave_frozen:
    'This leave has ended or been cancelled. It is the record of who could read what, and on which days, so it does not change.',
  coverer_unavailable:
    'The person chosen cannot cover this: they are not a clinician who signs their own notes, or they are away, leaving or gone for some of it.',
  not_on_caseload: 'That client is no longer on this caseload, so there is nothing to decide.',
  bad_transition: 'A leave that has started cannot be cancelled. It ends early instead, and keeps the days it was on.',
  supervision_uncovered:
    'This person supervises somebody. Name a supervisor to countersign in their place while they are away.',
  supervision_cover_unavailable:
    'The person chosen cannot cover this supervision: they are not a supervisor, or they are away, leaving or gone for some of it.',
};

export function Refusal({ code, messages = REFUSAL }: { code?: string; messages?: Record<string, string> }) {
  if (!code) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded-[var(--radius)] border px-3 py-2 text-body"
      style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
    >
      {messages[code] ?? 'That could not be done.'}
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

export function DateInput({ name, label, min, defaultValue }: { name: string; label: string; min?: string; defaultValue?: string }) {
  return (
    <div>
      <label htmlFor={name} className="block text-micro font-medium tracking-wide text-subtle uppercase">{label}</label>
      <input id={name} name={name} type="date" min={min} defaultValue={defaultValue} required className={CONTROL} style={CONTROL_STYLE} />
    </div>
  );
}
