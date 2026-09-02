/**
 * The mark is the product's argument, drawn.
 *
 * Three rings for the three sensitivity tiers — operational on the outside,
 * clinical in the middle, private at the centre — and a path that comes in
 * from outside, through the gap, and stops before the core. Access reaches the
 * record. It does not reach the middle of it.
 *
 * One colour (currentColor) so it works in a header, on a login card, at
 * favicon size, and in a print export. No gradient, no second mark.
 */
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
      {/* Operational: the outermost ring, open where the path comes in. */}
      <path
        d="M2.34 9.41 A 10 10 0 1 1 2.34 14.59"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.38"
      />
      {/* Clinical: closed, and reachable. */}
      <circle cx="12" cy="12" r="6.25" stroke="currentColor" strokeWidth="1.5" opacity="0.72" />
      {/* Private: solid, and never opened from outside. */}
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      {/* The path, stopping short. */}
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
