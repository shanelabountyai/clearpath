/**
 * The button, alone in its own file.
 *
 * It lives here rather than in `primitives.tsx` for a build reason worth
 * knowing: that module imports `CHARGEABLE` from `scheduling/lifecycle`, which
 * reaches the database, so anything importing it is server-only. The sign-in
 * forms are client components — they need `useActionState` to show a pending
 * button and a refusal — and importing the button from there dragged `pg` into
 * the browser bundle and failed the production build.
 *
 * A leaf with no data behind it belongs on its own anyway. `primitives.tsx`
 * re-exports it, so every existing import site is unchanged.
 */
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
