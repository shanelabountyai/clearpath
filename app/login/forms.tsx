'use client';

import { useActionState } from 'react';
import { Button } from '@/src/ui/button';
import { submitCode, submitEnrolment, submitPassword, type LoginState } from './actions';

const INPUT =
  'mt-1 w-full rounded-[var(--radius)] border px-3 py-2 text-body';
const INPUT_STYLE = { borderColor: 'var(--border)', background: 'var(--surface-raised)' };

function Problem({ state }: { state: LoginState }) {
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

export function PasswordForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(submitPassword, undefined);
  return (
    <form action={action} className="mt-6">
      <label htmlFor="email" className="block text-caption font-medium">Email</label>
      <input
        id="email" name="email" type="email" required autoComplete="username" autoFocus
        className={INPUT} style={INPUT_STYLE}
      />

      <label htmlFor="password" className="mt-4 block text-caption font-medium">Password</label>
      <input
        id="password" name="password" type="password" required autoComplete="current-password"
        className={INPUT} style={INPUT_STYLE}
      />

      <Problem state={state} />

      <Button type="submit" disabled={pending} className="mt-4 w-full">
        {pending ? 'Checking…' : 'Sign in'}
      </Button>
    </form>
  );
}

/** Six digits, one field. `inputMode` matters: this is typed off a phone. */
function CodeField() {
  return (
    <>
      <label htmlFor="code" className="block text-caption font-medium">Six-digit code</label>
      <input
        id="code" name="code" required autoFocus
        inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
        className={`${INPUT} font-mono tracking-[0.3em]`} style={INPUT_STYLE}
      />
    </>
  );
}

export function ChallengeForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(submitCode, undefined);
  return (
    <form action={action} className="mt-6">
      <CodeField />
      <Problem state={state} />
      <Button type="submit" disabled={pending} className="mt-4 w-full">
        {pending ? 'Checking…' : 'Verify'}
      </Button>
    </form>
  );
}

export function EnrolmentForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(submitEnrolment, undefined);
  return (
    <form action={action} className="mt-6">
      <CodeField />
      <Problem state={state} />
      <Button type="submit" disabled={pending} className="mt-4 w-full">
        {pending ? 'Checking…' : 'Finish setup'}
      </Button>
    </form>
  );
}
