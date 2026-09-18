// Its own file so a client component (ConfirmButton) can use it without
// importing primitives, which imports ConfirmButton back.

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
