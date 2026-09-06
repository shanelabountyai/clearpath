'use client';

import { useActionState } from 'react';
import { Button } from '@/src/ui/button';
import { requestReset, submitNewPassword, submitResetCode, type ResetState } from './actions';

const INPUT = 'mt-1 w-full rounded-[var(--radius)] border px-3 py-2 text-body';
const INPUT_STYLE = { borderColor: 'var(--border)', background: 'var(--surface-raised)' };

function Problem({ state }: { state: ResetState }) {
  if (!state?.error) return null;
  return (
    <p
      role="alert"
      className="mt-3 rounded-[var(--radius)] border px-3 py-2 text-caption"
      style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
    >
      {state.error}
    </p>
  );
}

/**
 * Asking for a link, and the answer that does not vary.
 *
 * The confirmation replaces the form rather than appearing beside it, because
 * a form still sitting there invites a second submit — and two live links to
 * one account is two chances for the older one to still be in a mailbox. The
 * server supersedes anyway; this is the screen agreeing with it.
 */
export function RequestForm({ sentMessage }: { sentMessage: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(requestReset, undefined);

  if (state?.sent) {
    return (
      <p
        role="status"
        className="mt-6 rounded-[var(--radius-lg)] border px-4 py-3 text-body"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
      >
        {sentMessage}
      </p>
    );
  }

  return (
    <form action={action} className="mt-6">
      <label htmlFor="email" className="block text-caption font-medium">Email</label>
      <input
        id="email" name="email" type="email" required autoComplete="username" autoFocus
        className={INPUT} style={INPUT_STYLE}
      />
      <Problem state={state} />
      <Button type="submit" disabled={pending} className="mt-4 w-full">
        {pending ? 'Sending…' : 'Send me a link'}
      </Button>
    </form>
  );
}

export function ResetCodeForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(submitResetCode, undefined);
  return (
    <form action={action} className="mt-6">
      <input type="hidden" name="token" value={token} />
      <label htmlFor="code" className="block text-caption font-medium">Six-digit code</label>
      <input
        id="code" name="code" required autoFocus
        inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
        className={`${INPUT} font-mono tracking-[0.3em]`} style={INPUT_STYLE}
      />
      <Problem state={state} />
      <Button type="submit" disabled={pending} className="mt-4 w-full">
        {pending ? 'Checking…' : 'Verify'}
      </Button>
    </form>
  );
}

export function NewPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(submitNewPassword, undefined);
  return (
    <form action={action} className="mt-6">
      <input type="hidden" name="token" value={token} />

      <label htmlFor="password" className="block text-caption font-medium">New password</label>
      <input
        id="password" name="password" type="password" required autoFocus
        autoComplete="new-password" className={INPUT} style={INPUT_STYLE}
      />

      <label htmlFor="confirm" className="mt-4 block text-caption font-medium">Type it again</label>
      <input
        id="confirm" name="confirm" type="password" required
        autoComplete="new-password" className={INPUT} style={INPUT_STYLE}
      />

      <Problem state={state} />
      <Button type="submit" disabled={pending} className="mt-4 w-full">
        {pending ? 'Saving…' : 'Set my password'}
      </Button>
    </form>
  );
}
