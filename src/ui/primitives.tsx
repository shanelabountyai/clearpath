import type { ReactNode } from 'react';

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
export function LockedPanel({
  title = 'Process notes',
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby="locked-title"
      className="rounded-[var(--radius-lg)] border border-dashed p-5"
      style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-sunken)' }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden style={{ color: 'var(--tier-private)' }}>⬤</span>
        <h2 id="locked-title" className="font-semibold">{title}</h2>
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
      <p className="mt-2 text-caption text-subtle">
        The official record for these sessions is under Progress notes.
      </p>
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

export function Badge({ tone = 'neutral', glyph, children }: { tone?: Tone; glyph?: string; children: ReactNode }) {
  const v = TONE_VARS[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium whitespace-nowrap"
      style={{ color: v.fg, background: v.bg }}
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

export function StatusChip({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, glyph: '·', tone: 'neutral' as Tone };
  return <Badge tone={meta.tone} glyph={meta.glyph}>{meta.label}</Badge>;
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

export const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export type ButtonVariant = 'solid' | 'quiet' | 'danger' | 'private';

const BUTTON_FILL: Record<ButtonVariant, { background: string; color: string; borderColor: string }> = {
  solid: { background: 'var(--accent)', color: 'var(--accent-contrast)', borderColor: 'var(--accent)' },
  quiet: { background: 'transparent', color: 'var(--text)', borderColor: 'var(--border-strong)' },
  // Chargeable or irreversible. Red is spoken for, and this is what spends it.
  danger: { background: 'var(--danger)', color: 'var(--on-solid)', borderColor: 'var(--danger)' },
  // Author-only actions carry the private tier's colour, so the one place a
  // clinician writes something nobody else will read looks like nowhere else.
  private: { background: 'var(--tier-private)', color: 'var(--on-solid)', borderColor: 'var(--tier-private)' },
};

/**
 * `--on-solid` rather than white: in dark mode the danger and private fills are
 * light, and white text on them fails contrast. A solid button is the one place
 * the foreground cannot be inherited.
 */
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
