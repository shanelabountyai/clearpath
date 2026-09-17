/**
 * Clearpath Design System — component bundle entry.
 *
 * This is an adapted copy of src/ui/primitives.tsx and src/ui/logo.tsx from
 * the Clearpath repository, for standalone browser bundling. Three changes
 * from the real source, each isolated to this file:
 *
 *  1. `next/link`'s <Link> is shimmed to a plain <a> (no Next.js router here).
 *  2. `CHARGEABLE` and the two time helpers are inlined verbatim from their
 *     real modules (../scheduling/lifecycle, ../time) instead of imported,
 *     because those modules pull in Prisma and server-only auth code that
 *     cannot run in a browser bundle.
 *  3. Type-only imports (DaySession) are dropped; nothing here is type-checked.
 *
 * Every component body below — every class name, every style, every rule in
 * the comments — is copied unchanged from the real source.
 */
import type { ReactNode } from 'react';

// ---- shim: next/link -------------------------------------------------
function Link(props: React.ComponentPropsWithoutRef<'a'> & { href: string }) {
  return <a {...props} />;
}

// ---- inlined: src/scheduling/lifecycle.ts's CHARGEABLE ----------------
const CHARGEABLE: readonly string[] = ['no_show', 'late_cancelled'];

// ---- inlined: src/time.ts's localDateOf / minutesToHHMM ---------------
const PRACTICE_TZ = 'America/New_York';
const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRACTICE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});
function partsOf(instant: Date) {
  const p = Object.fromEntries(
    partsFmt.formatToParts(instant).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const hour = p.hour === '24' ? '00' : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(hour), minute: Number(p.minute), second: Number(p.second),
  };
}
function localDateOf(instant: Date): string {
  return partsOf(instant).date;
}
const minutesToHHMM = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// =========================================================================
// The visual vocabulary. Two rules run through all of it:
//
//  - Nothing means anything by colour alone. Every tier and every status
//    carries a glyph or a weight as well.
//  - A denial is a designed state, not an error state. A supervisor who cannot
//    open a process note has done nothing wrong and should not be shown a red
//    box that says so.
// =========================================================================

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

const PROCESS_NOTE_FOOTNOTE = 'The official record for these sessions is under Progress notes.';

export function LockedPanel({
  title = 'Process notes',
  children,
  footnote,
}: {
  title?: string;
  children?: ReactNode;
  footnote?: ReactNode;
}) {
  return (
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
  late_cancelled: { label: 'Late cancel', glyph: '⊗', tone: 'danger' },
};

export const CONFIRMATION_META: Record<string, { label: string; glyph: string; tone: Tone }> = {
  not_required: { label: 'Not asked', glyph: '–', tone: 'neutral' },
  pending: { label: 'Awaiting reply', glyph: '⋯', tone: 'info' },
  confirmed: { label: 'Client confirmed', glyph: '✓', tone: 'success' },
  declined: { label: 'Client declined', glyph: '✕', tone: 'neutral' },
  no_response: { label: 'No reply', glyph: '?', tone: 'warning' },
};

export function StatusChip({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, glyph: '·', tone: 'neutral' as Tone };
  const chargeable = CHARGEABLE.includes(status);
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
  name, label, defaultValue = '', options, id = name,
}: {
  name: string; label: string; defaultValue?: string; options: { value: string; label: string }[]; id?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>{label}</label>
      <select id={id} name={name} defaultValue={defaultValue} className={FIELD_CONTROL} style={FIELD_CONTROL_STYLE}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

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

export function ageTone(days: number) {
  if (days >= 14) return { tone: 'danger' as const, label: `${days} days` };
  if (days >= 7) return { tone: 'warning' as const, label: `${days} days` };
  return { tone: 'neutral' as const, label: days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}` };
}

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
          <button
            className="rounded-[var(--radius)] px-3 py-1.5 text-caption font-medium"
            style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            Co-sign
          </button>
        </form>
      </div>
    </li>
  );
}

const AUDIT_CODE = /^[a-z_]+:[\w-]+$/;

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

type ButtonVariant = 'solid' | 'quiet' | 'danger' | 'private';

const BUTTON_FILL: Record<ButtonVariant, { background: string; color: string; borderColor: string }> = {
  solid: { background: 'var(--accent)', color: 'var(--accent-contrast)', borderColor: 'var(--accent)' },
  quiet: { background: 'transparent', color: 'var(--text)', borderColor: 'var(--border-strong)' },
  danger: { background: 'var(--danger)', color: 'var(--on-solid)', borderColor: 'var(--danger)' },
  private: { background: 'var(--tier-private)', color: 'var(--on-solid)', borderColor: 'var(--tier-private)' },
};

export function Button({
  variant = 'solid',
  className = '',
  ...props
}: { variant?: ButtonVariant } & React.ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      {...props}
      className={`rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium whitespace-nowrap ${className}`}
      style={{ ...BUTTON_FILL[variant], ...props.style }}
    />
  );
}

export function AppointmentChip({
  session,
  top,
  height,
  group,
}: {
  session: {
    id: string; status: string; modality: string; seriesId: string | null; detached: boolean;
    startMinute: number; endMinute: number;
    client: { lastName: string }; clinician: { name: string };
  };
  top: number;
  height: number;
  group?: { id: string; topic: string | null; count: number };
}) {
  const meta = STATUS_META[session.status] ?? { label: session.status, glyph: '·', tone: 'neutral' as Tone };
  const statusVar = `var(--status-${session.status.replace('_', '-')})`;
  const cancelled = session.status === 'cancelled' || session.status === 'late_cancelled';
  const live = session.status === 'arrived' || session.status === 'in_session';
  const chargeable = CHARGEABLE.includes(session.status);
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
        background: chargeable ? `${HATCH}, ${background}` : background,
        borderLeftWidth: live ? 5 : 3,
        opacity: cancelled ? 0.72 : 1,
        transition: 'box-shadow var(--motion-state) var(--motion-ease)',
        color: chargeable ? 'var(--danger)' : undefined,
      } as React.CSSProperties}
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

// =========================================================================
// The mark — src/ui/logo.tsx, verbatim.
// =========================================================================

export function Logo({ size = 22, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role="img"
      aria-label="Clearpath"
    >
      <path
        d="M2.34 9.41 A 10 10 0 1 1 2.34 14.59"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.38"
      />
      <circle cx="12" cy="12" r="6.25" stroke="currentColor" strokeWidth="1.5" opacity="0.72" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      <path d="M0.9 12 H 4.85" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ practice, size = 'md' }: { practice?: string; size?: 'sm' | 'md' }) {
  const glyph = size === 'sm' ? 20 : 26;
  return (
    <span className="flex items-center gap-2.5">
      <Logo size={glyph} className="shrink-0 text-accent" />
      <span className="leading-tight">
        <span className={`block font-semibold tracking-tight ${size === 'sm' ? 'text-subhead' : 'text-title'}`}>
          Clearpath
        </span>
        {practice && <span className="block text-micro text-subtle">{practice}</span>}
      </span>
    </span>
  );
}
