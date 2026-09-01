import { startBreakGlass } from '../actions';

/**
 * What a practice manager meets instead of a record.
 *
 * The friction is deliberate and proportionate: a reason is required, the
 * consequence is stated plainly, and the access is attributed. It is not
 * punitive — somebody reaches for this when a client is in crisis and the
 * clinician is unreachable, and it should not feel like an accusation.
 */
export function BreakGlassPrompt({ resource }: { resource: string }) {
  return (
    <div className="mx-auto max-w-lg py-10">
      <div
        className="rounded-[var(--radius-lg)] border p-5"
        style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-raised)' }}
      >
        <h1 className="text-lg font-semibold">Break-glass access required</h1>
        <p className="mt-2 text-[13.5px] text-muted">
          Your role administers the practice rather than its clinical records. You can open{' '}
          {resource} in an emergency, and doing so is recorded against your name with the
          reason you give.
        </p>
        <form action={startBreakGlass} className="mt-4">
          <label htmlFor="reason" className="block text-[11.5px] font-medium tracking-wide text-subtle uppercase">
            Reason (required)
          </label>
          <textarea
            id="reason" name="reason" rows={3} required minLength={10}
            placeholder="e.g. client called the practice in distress and their clinician is on leave"
            className="mt-1 w-full rounded-[var(--radius)] border p-2.5 text-[13.5px]"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[12px] text-subtle">
              Break-glass reaches demographics and progress notes. It does not reach
              process notes — nothing does.
            </p>
            <button
              className="shrink-0 rounded-[var(--radius)] px-3 py-1.5 text-[13px] font-medium"
              style={{ background: 'var(--danger)', color: '#fff' }}
            >
              Break glass
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
