import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { CHARGEABLE } from '../scheduling/states';
import { AUDIT_CODE } from '../reports/audit-code';
import { localDateOf, minutesToHHMM } from '../time';
import type { DaySession } from '../scheduling/calendar';
import { Button, type ButtonVariant } from './button';
import { ConfirmButton } from './confirm-button';

/**
 * The visual vocabulary. Two rules run through all of it:
 *
 *  - Nothing means anything by colour alone. Every tier and every status
 *    carries a glyph or a weight as well.
 *  - A denial is a designed state, not an error state. A supervisor who cannot
 *    open a process note has done nothing wrong and should not be shown a red
 *    box that says so.
 */

export type Tier = 'operational' | 'clinical' | 'private';

const TIER_META: Record<Tier, { label: string; glyph: string; hint: string }> = {
  operational: {
    label: 'Operational',
    glyph: '◷',
    hint: 'Scheduling and contact details. No clinical content.',
  },
  clinical: {
    label: 'Clinical',
    glyph: '◈',
    hint: 'The official record. Treating clinician, and supervisor where applicable.',
  },
  private: {
    label: 'Private',
    glyph: '⬤',
    hint: 'Author only. Not visible to supervisors, managers, or break-glass.',
  },
};

export function TierBanner({ tier, children }: { tier: Tier; children?: ReactNode }) {
  const meta = TIER_META[tier];
  return (
    <div
      className="flex items-start gap-2.5 rounded-[var(--radius)] border px-3 py-2 text-body"
      style={{
        borderColor: `var(--tier-${tier})`,
        background: `var(--tier-${tier}-soft)`,
        color: 'var(--text)',
      }}
    >
      <span aria-hidden className="mt-px text-subhead leading-none" style={{ color: `var(--tier-${tier})` }}>
        {meta.glyph}
      </span>
      <div>
        <span className="font-semibold" style={{ color: `var(--tier-${tier})` }}>
          {meta.label}
        </span>
        <span className="text-muted"> — {children ?? meta.hint}</span>
      </div>
    </div>
  );
}

/**
 * The most important component in the product: what a supervisor sees where a
 * supervisee's process notes would be.
 *
 * It shows that the section exists, states the rule in plain language, and
 * offers no override affordance of any kind — no "request access", no
 * "justify", no disabled button implying a door. There is no door.
 */
/** The one redirection that is always true of a refused process note: the
 *  progress note exists, is the official record, and is not private. */
const PROCESS_NOTE_FOOTNOTE = 'The official record for these sessions is under Progress notes.';

export function LockedPanel({
  title = 'Process notes',
  children,
  footnote,
}: {
  title?: string;
  children?: ReactNode;
  /** Where the reader should go instead, when there is somewhere. Opt-in: this
   *  used to be a hardcoded line pointing at progress notes, which four
   *  callers that are not about notes at all inherited and contradicted. */
  footnote?: ReactNode;
}) {
  return (
    // Named by `aria-label`, not by `aria-labelledby` to a fixed id: the design
    // gallery shows two of these at once, and one title carries a clinician's
    // name, so any id here is either duplicated or unpredictable. Both callers
    // want this found as a region by its name anyway.
    <section
      aria-label={title}
      className="rounded-[var(--radius-lg)] border border-dashed p-5"
      style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-sunken)' }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden style={{ color: 'var(--tier-private)' }}>⬤</span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      <p className="mt-2 max-w-prose text-body text-muted">
        {children ?? (
          <>
            Process notes are the author&rsquo;s own working record and are visible only to
            the clinician who wrote them. That includes supervisors of the author, the
            practice manager, and break-glass access. This is a rule of the practice,
            not a permission you are missing.
          </>
        )}
      </p>
      {(footnote ?? (children ? null : PROCESS_NOTE_FOOTNOTE)) && (
        <p className="mt-2 text-caption text-subtle">{footnote ?? PROCESS_NOTE_FOOTNOTE}</p>
      )}
    </section>
  );
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONE_VARS: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: 'var(--text-muted)', bg: 'var(--surface-inset)' },
  accent: { fg: 'var(--accent)', bg: 'var(--accent-soft)' },
  success: { fg: 'var(--success)', bg: 'var(--success-soft)' },
  warning: { fg: 'var(--warning)', bg: 'var(--warning-soft)' },
  danger: { fg: 'var(--danger)', bg: 'var(--danger-soft)' },
  info: { fg: 'var(--info)', bg: 'var(--info-soft)' },
};

/*
 * The hatch: a fill that reads without colour vision, layered over a tone's
 * soft background. It marks money - a status that will appear on a bill.
 */
const HATCH =
  'repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, currentColor 14%, transparent) 3px 4.5px)';

export function Badge({
  tone = 'neutral',
  glyph,
  hatched = false,
  children,
}: {
  tone?: Tone;
  glyph?: string;
  hatched?: boolean;
  children: ReactNode;
}) {
  const v = TONE_VARS[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium whitespace-nowrap"
      style={{ color: v.fg, background: hatched ? `${HATCH}, ${v.bg}` : v.bg }}
    >
      {glyph && <span aria-hidden>{glyph}</span>}
      {children}
    </span>
  );
}

export const STATUS_META: Record<string, { label: string; glyph: string; tone: Tone }> = {
  scheduled: { label: 'Scheduled', glyph: '○', tone: 'neutral' },
  confirmed: { label: 'Confirmed', glyph: '◍', tone: 'info' },
  arrived: { label: 'Arrived', glyph: '◐', tone: 'warning' },
  in_session: { label: 'In session', glyph: '◉', tone: 'accent' },
  completed: { label: 'Completed', glyph: '●', tone: 'success' },
  no_show: { label: 'No show', glyph: '✕', tone: 'danger' },
  cancelled: { label: 'Cancelled', glyph: '⊘', tone: 'neutral' },
  // Chargeable, and so must never be mistaken for an ordinary cancellation.
  late_cancelled: { label: 'Late cancel', glyph: '⊗', tone: 'danger' },
};

/**
 * The other column, and deliberately a quieter treatment than status.
 *
 * "Did you answer my message" is not "were you in the room" (D-02), and the
 * page must not let a reader collapse them at a glance — so this renders as a
 * plain badge beside the status chip rather than as a second chip competing
 * with it. `no_response` is a warning rather than a danger: it is the fact the
 * fee rests on, but the fee is the status chip's business.
 */
export const CONFIRMATION_META: Record<string, { label: string; glyph: string; tone: Tone }> = {
  not_required: { label: 'Not asked', glyph: '–', tone: 'neutral' },
  pending: { label: 'Awaiting reply', glyph: '⋯', tone: 'info' },
  confirmed: { label: 'Client confirmed', glyph: '✓', tone: 'success' },
  declined: { label: 'Client declined', glyph: '✕', tone: 'neutral' },
  no_response: { label: 'No reply', glyph: '?', tone: 'warning' },
};

/**
 * `no_show` and `late_cancelled` share a hue and a tone by design - both are
 * red, both are bad news - but both also take money, and money must not hang
 * off a glyph difference alone at 11.5px. The chargeable treatment is a hatch
 * fill plus a currency mark, and WHICH statuses get it comes from the state
 * machine's own CHARGEABLE list, never a copy kept here.
 */
export function StatusChip({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, glyph: '·', tone: 'neutral' as Tone };
  const chargeable = (CHARGEABLE as readonly string[]).includes(status);
  return (
    <Badge tone={meta.tone} glyph={meta.glyph} hatched={chargeable}>
      {meta.label}
      {chargeable && (
        <>
          <span aria-hidden>·&thinsp;$</span>
          <span className="sr-only">, chargeable</span>
        </>
      )}
    </Badge>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-[var(--radius-lg)] border p-4 ${className}`}
      style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)', boxShadow: 'var(--shadow-sm)' }}
    >
      {children}
    </div>
  );
}

/**
 * A box whose contents are wider than it is. A div that scrolls but holds no
 * focusable child is unreachable by keyboard — the wide table on `/audit` was
 * simply unreadable without a mouse — so the box itself takes focus. A
 * focusable thing has to say what it is, which is why the label is required
 * rather than optional: every caller is forced to name its own table.
 */
export function ScrollX({ label, className = '', style, children }: {
  label: string; className?: string; style?: CSSProperties; children: ReactNode;
}) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className={`scroll-x ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-title font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-body text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      className="rounded-[var(--radius-lg)] border border-dashed px-5 py-10 text-center"
      style={{ borderColor: 'var(--border)' }}
    >
      <p className="font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-prose text-body text-muted">{children}</p>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-micro font-medium tracking-wide text-subtle uppercase">{label}</dt>
      <dd className="mt-0.5">{children || <span className="text-subtle">—</span>}</dd>
    </div>
  );
}

const FIELD_LABEL = 'block text-micro font-medium tracking-wide text-subtle uppercase';
const FIELD_CONTROL = 'mt-1 w-full rounded-[var(--radius)] border px-2 py-1.5 text-body';
const FIELD_CONTROL_STYLE = { borderColor: 'var(--border)', background: 'var(--surface)' };

/**
 * A form input, labelled — `Field`'s sibling for writing rather than reading.
 * Three pages each reinvented this independently before it was one component.
 *
 * `id` defaults to the field name and is overridden where two forms on the
 * same page collect the same one — a duplicated DOM id makes `htmlFor`
 * ambiguous, and a screen reader then announces the wrong label for the
 * wrong box.
 */
export function TextField({
  name, label, type = 'text', required = false, min, defaultValue, id = name,
}: {
  name: string; label: string; type?: string; required?: boolean; min?: string; defaultValue?: string; id?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>{label}</label>
      <input
        id={id} name={name} type={type} required={required} min={min} defaultValue={defaultValue}
        className={FIELD_CONTROL} style={FIELD_CONTROL_STYLE}
      />
    </div>
  );
}

export function SelectField({
  name, label, defaultValue = '', options, id = name, placeholder,
}: {
  name: string; label: string; defaultValue?: string; options: { value: string; label: string }[]; id?: string;
  /** A blank first option, and the select becomes required: nobody is chosen by default. */
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>{label}</label>
      <select id={id} name={name} defaultValue={defaultValue} required={!!placeholder} className={FIELD_CONTROL} style={FIELD_CONTROL_STYLE}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/**
 * A screener submission's right column — score, why it flagged, and the
 * signature — each conditional on that fact existing at all.
 */
export function ScreenerResult({
  totalScore, band, needsReview, reviewReasons, signatureName, submittedAt,
}: {
  totalScore: number | null;
  band?: { label: string } | null;
  needsReview: boolean;
  reviewReasons: readonly string[];
  signatureName: string | null;
  submittedAt: Date;
}) {
  return (
    <div className="space-y-4">
      {totalScore !== null && (
        <Card>
          <h2 className="mb-1 font-semibold">Score</h2>
          <p className="font-mono text-3xl">{totalScore}</p>
          {band && <p className="mt-1 text-body text-muted">{band.label} band</p>}
          <p className="mt-3 text-caption text-subtle">
            A total is a conversation starter, not a diagnosis, and not a trend to chase.
          </p>
        </Card>
      )}
      {needsReview && (
        <Card>
          <h2 className="mb-1 font-semibold">Why this is flagged</h2>
          <ul className="space-y-1 font-mono text-caption text-muted">
            {reviewReasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
          <p className="mt-2 text-caption text-subtle">
            Reason codes are what travel to the alert and the audit log. The answers do not.
          </p>
        </Card>
      )}
      {signatureName && (
        <Card>
          <h2 className="mb-1 font-semibold">Signature</h2>
          <p className="font-serif text-subhead">{signatureName}</p>
          <p className="text-caption text-subtle">Typed name, {localDateOf(submittedAt)}</p>
        </Card>
      )}
    </div>
  );
}

/**
 * Ageing escalates, but not at day two. An unsigned supervisee note is a
 * compliance clock, and a queue that shouts on the first day teaches people to
 * ignore it.
 */
export function ageTone(days: number) {
  if (days >= 14) return { tone: 'danger' as const, label: `${days} days` };
  if (days >= 7) return { tone: 'warning' as const, label: `${days} days` };
  return { tone: 'neutral' as const, label: days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}` };
}

/** One row in the co-signature queue. The action arrives as a prop, the same
 *  way `BreakGlassDialog`'s does: primitives never import from app/. */
export function CoSignRow({
  note, action,
}: {
  note: {
    id: string;
    client: { lastName: string; firstName: string; code: string };
    author: { name: string };
    appointment: { startAt: Date } | null;
    signedAt: Date | null;
    waitingDays: number;
  };
  action: (formData: FormData) => void | Promise<void>;
}) {
  const age = ageTone(note.waitingDays);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <Link href={`/notes/${note.id}`} className="font-medium text-accent hover:underline">
          {note.client.lastName}, {note.client.firstName}
        </Link>
        <p className="text-caption text-muted">
          <span className="font-mono">{note.client.code}</span> · {note.author.name} ·
          session {note.appointment ? localDateOf(note.appointment.startAt) : '—'} ·
          signed {note.signedAt ? localDateOf(note.signedAt) : '—'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={age.tone}>waiting {age.label}</Badge>
        <form action={action}>
          <input type="hidden" name="noteId" value={note.id} />
          <input type="hidden" name="returnTo" value="queue" />
          <ConfirmButton
            className="text-caption"
            title={`Co-sign ${note.author.name}'s note for ${note.client.code}?`}
            consequence="Your countersignature completes the record, and it cannot be withdrawn. Open the note first if you have not read it."
            confirmLabel="Co-sign"
          >
            Co-sign
          </ConfirmButton>
        </form>
      </div>
    </li>
  );
}

/** `leave:<id>`, `departure:decided_transfer`: a namespace and an identifier, nothing a person typed. */

/**
 * One row of the audit log. Names are resolved by the caller and passed in —
 * the log itself stores ids, and a primitive has no business querying users.
 */
export function AuditRow({
  row, actorLabel, roleLabel, clientLabel,
}: {
  row: {
    id: string; at: Date; action: string; resource: string;
    breakGlass: boolean; allowed: boolean; reason: string | null;
  };
  actorLabel: ReactNode;
  roleLabel: string;
  clientLabel: string;
}) {
  return (
    <tr style={{ background: row.breakGlass ? 'var(--danger-soft)' : !row.allowed ? 'var(--warning-soft)' : undefined }}>
      <td className="border-b px-3 py-1.5 font-mono whitespace-nowrap text-subtle" style={{ borderColor: 'var(--border)' }}>
        {row.at.toISOString().replace('T', ' ').slice(0, 19)}
      </td>
      <td className="border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>{actorLabel}</td>
      <td className="border-b px-3 py-1.5 text-muted" style={{ borderColor: 'var(--border)' }}>{roleLabel}</td>
      <td className="border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>{row.action}</td>
      <td className="border-b px-3 py-1.5 font-mono" style={{ borderColor: 'var(--border)' }}>{row.resource}</td>
      <td className="border-b px-3 py-1.5 font-mono text-muted" style={{ borderColor: 'var(--border)' }}>{clientLabel}</td>
      <td className="border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>
        {row.breakGlass && <Badge tone="danger" glyph="⚠">break-glass</Badge>}{' '}
        {row.allowed ? <Badge tone="success" glyph="✓">allowed</Badge> : <Badge tone="warning" glyph="⊘">denied</Badge>}
      </td>
      <td className="border-b px-3 py-1.5 text-muted" style={{ borderColor: 'var(--border)' }}>
        {/* Only a code is a link. A break-glass justification is somebody's free text,
            and free text never goes in a URL (hard rule 3). */}
        {row.reason && AUDIT_CODE.test(row.reason) ? (
          <Link href={`/audit?reason=${encodeURIComponent(row.reason)}`} className="font-mono hover:underline">{row.reason}</Link>
        ) : (row.reason ?? '')}
      </td>
    </tr>
  );
}

export const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export { Button, type ButtonVariant };

/**
 * One session in a day column. A calendar chip is not a badge: it has to say
 * status, modality, series membership and money in about 40px of height, and
 * the primary line has to read at 13px (text-body) because the day view is
 * what a clinician stares at all day.
 *
 *  - The LEFT EDGE carries the weight: status colour, and thicker while the
 *    session is live (arrived / in session) so "now" is findable at a glance.
 *  - MODALITY is a shape, not a word: ▮ is a room, ◠ is a call.
 *  - A SERIES member carries ↻ (standing) or ↷ (moved off its pattern).
 *  - A CHARGEABLE outcome gets the same hatch + currency mark as StatusChip,
 *    from the same CHARGEABLE list.
 */
export function AppointmentChip({
  session,
  top,
  height,
  group,
}: {
  session: DaySession;
  top: number;
  height: number;
  /**
   * Set when this chip stands for a whole group session. Six attendees at 3pm
   * are one booking of the room, so they are one chip — six stacked chips would
   * read as the double-booking the constraints exist to prevent.
   */
  group?: { id: string; topic: string | null; count: number };
}) {
  const meta = STATUS_META[session.status] ?? { label: session.status, glyph: '·', tone: 'neutral' as Tone };
  const statusVar = `var(--status-${session.status.replace('_', '-')})`;
  const cancelled = session.status === 'cancelled' || session.status === 'late_cancelled';
  const live = session.status === 'arrived' || session.status === 'in_session';
  const chargeable = (CHARGEABLE as readonly string[]).includes(session.status);
  const telehealth = session.modality === 'telehealth';
  const background = cancelled ? 'var(--surface-sunken)' : 'var(--surface-raised)';
  return (
    <Link
      href={group ? `/groups/${group.id}` : `/appointments/${session.id}`}
      className="absolute inset-x-1 block overflow-hidden rounded-[var(--radius)] border px-1.5 py-1 text-micro"
      style={{
        top,
        height,
        borderColor: statusVar,
        // Cancelled sessions stay visible but recede — the hour is free, and
        // the record of who was meant to be in it still matters.
        background: chargeable ? `${HATCH}, ${background}` : background,
        borderLeftWidth: live ? 5 : 3,
        opacity: cancelled ? 0.72 : 1,
        transition: 'box-shadow var(--motion-state) var(--motion-ease)',
        color: chargeable ? 'var(--danger)' : undefined,
      }}
    >
      <div className="flex items-center gap-1 text-body font-medium" style={{ color: 'var(--text)' }}>
        <span aria-hidden style={{ color: statusVar }}>{meta.glyph}</span>
        <span className="truncate" style={{ textDecoration: cancelled ? 'line-through' : undefined }}>
          {group ? (group.topic ?? 'Group session') : session.client.lastName}
        </span>
        {group && <span className="shrink-0 text-micro text-subtle">×{group.count}</span>}
        {chargeable && (
          <>
            <span aria-hidden style={{ color: 'var(--danger)' }}>$</span>
            <span className="sr-only">chargeable</span>
          </>
        )}
      </div>
      <div className="truncate text-nano text-subtle">
        <span aria-hidden>{telehealth ? '◠' : '▮'} </span>
        <span className="sr-only">{telehealth ? 'telehealth, ' : 'in person, '}</span>
        {minutesToHHMM(session.startMinute)} · {session.clinician.name.split(' ')[0]}
        {session.seriesId && (
          <>
            {' '}
            <span aria-hidden>{session.detached ? '↷' : '↻'}</span>
            <span className="sr-only">{session.detached ? ', moved off its series' : ', standing appointment'}</span>
          </>
        )}
      </div>
    </Link>
  );
}

/**
 * What a practice manager meets instead of a record.
 *
 * The friction is deliberate and proportionate: a reason is required, the
 * consequence is stated plainly, and the access is attributed. It is not
 * punitive — somebody reaches for this when a client is in crisis and the
 * clinician is unreachable, and it should not feel like an accusation.
 *
 * The server action arrives as a prop: primitives never import from app/.
 */
export function BreakGlassDialog({
  resource,
  action,
}: {
  resource: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <div className="mx-auto max-w-lg py-10">
      <div
        className="rounded-[var(--radius-lg)] border p-5"
        style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-raised)' }}
      >
        <h1 className="text-lg font-semibold">Break-glass access required</h1>
        <p className="mt-2 text-body text-muted">
          Your role administers the practice rather than its clinical records. You can open{' '}
          {resource} in an emergency, and doing so is recorded against your name with the
          reason you give.
        </p>
        <form action={action} className="mt-4">
          <label htmlFor="reason" className="block text-micro font-medium tracking-wide text-subtle uppercase">
            Reason (required)
          </label>
          <textarea
            id="reason" name="reason" rows={3} required minLength={10}
            placeholder="e.g. client called the practice in distress and their clinician is on leave"
            className="mt-1 w-full rounded-[var(--radius)] border p-2.5 text-body"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-caption text-subtle">
              Break-glass reaches demographics and progress notes. It does not reach
              process notes — nothing does.
            </p>
            <Button variant="danger" className="shrink-0">
              Break glass
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * The standing reminder that break-glass is open. It renders from the staff
 * LAYOUT, above every page, so it persists across route changes for the whole
 * duration of the access — the one place it must never be possible to
 * navigate away from.
 */
export function BreakGlassBar({
  reason,
  endAction,
}: {
  reason: string;
  endAction: () => void | Promise<void>;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-2"
      style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
    >
      <p className="text-body">
        <span aria-hidden>⚠ </span>
        <strong>Break-glass access is open.</strong> Everything you open is logged against
        your name with this reason: <em>{reason}</em>
      </p>
      <form action={endAction}>
        <button
          type="submit"
          className="rounded-[var(--radius)] border px-2.5 py-1 text-caption font-medium"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          Close break-glass
        </button>
      </form>
    </div>
  );
}
