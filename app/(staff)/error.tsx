'use client';

/**
 * The staff shell's error boundary. It sits inside the (staff) layout, so a
 * page that throws loses its own content and keeps the navigation. Before
 * this there was none anywhere, and one unrecognised alert kind replaced a
 * clinician's self-harm-flag queue with the framework's bare crash page.
 *
 * It never renders the error's message and never logs it (hard rule 3). A message
 * thrown from a client component reaches the browser verbatim, and nothing
 * guarantees what one says. The digest is an id that matches the server log,
 * so it is the only detail shown.
 */
export default function StaffError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-lg)] border px-5 py-6"
      style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
    >
      <h1 className="text-title font-semibold tracking-tight">This page could not load</h1>
      <p className="mt-1.5 max-w-prose text-body">
        Something went wrong while building it. The menu still works, so every other section is
        still reachable. Trying again is safe: it only reloads this page.
      </p>
      {error.digest && (
        <p className="mt-2 text-caption text-muted">
          Reference for support: <span className="font-mono">{error.digest}</span>
        </p>
      )}
      <button
        type="button"
        onClick={() => retry()}
        className="mt-4 rounded-[var(--radius)] px-4 py-2 text-body font-medium"
        style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
      >
        Try again
      </button>
    </div>
  );
}
