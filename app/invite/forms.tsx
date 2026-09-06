'use client';

import { useActionState } from 'react';
import { Button } from '@/src/ui/button';
import { claimAccount, type InviteState } from './actions';

const INPUT = 'mt-1 w-full rounded-[var(--radius)] border px-3 py-2 text-body';
const INPUT_STYLE = { borderColor: 'var(--border)', background: 'var(--surface-raised)' };

/**
 * Both halves on one screen, which is not the shortcut it looks like.
 *
 * A reset splits its code from its password because the code is a *challenge* —
 * something the account already holds, checked against a clock. This code is
 * the other half of one credential that was split when it was issued, so there
 * is no meaningful state between "typed the code" and "chose a password".
 * Storing a half-proved invitation would only be a second window in which the
 * link alone was enough.
 */
export function ClaimForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(claimAccount, undefined);

  return (
    <form action={action} className="mt-6">
      <input type="hidden" name="token" value={token} />

      <label htmlFor="code" className="block text-caption font-medium">
        The code you were given
      </label>
      <input
        id="code" name="code" required autoFocus autoComplete="off"
        placeholder="XXXX-XXXX" maxLength={9} spellCheck={false}
        className={`${INPUT} font-mono uppercase tracking-[0.2em]`} style={INPUT_STYLE}
      />
      <p className="mt-1 text-caption text-subtle">
        Not in the email. Whoever set up your account has it.
      </p>

      <label htmlFor="password" className="mt-5 block text-caption font-medium">
        Choose a password
      </label>
      <input
        id="password" name="password" type="password" required
        autoComplete="new-password" className={INPUT} style={INPUT_STYLE}
      />

      <label htmlFor="confirm" className="mt-4 block text-caption font-medium">Type it again</label>
      <input
        id="confirm" name="confirm" type="password" required
        autoComplete="new-password" className={INPUT} style={INPUT_STYLE}
      />

      {state?.error ? (
        <p
          role="alert"
          className="mt-3 rounded-[var(--radius)] border px-3 py-2 text-caption"
          style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
        >
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-4 w-full">
        {pending ? 'Setting up…' : 'Set up my account'}
      </Button>
    </form>
  );
}
