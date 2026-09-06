'use server';

import { redirect } from 'next/navigation';
import { systemClock } from '../../src/clock';
import { configuredMailer } from '../../src/auth/mailer';
import {
  completeReset,
  requestPasswordReset,
  submitResetSecondFactor,
} from '../../src/auth/recovery';

const deps = { clock: systemClock };

/**
 * The reset flow's server side, and the thing it deliberately does not do.
 *
 * None of these touches the session cookie. Completing a reset signs nobody in
 * — it sets a password and ends every session the account had, and the person
 * then goes to the front door like anybody else. A flow that handed back a
 * session at the end would make the link itself worth a session, which is the
 * whole property this phase exists to keep.
 */

/** The same default the reminder cadence uses for the client's own door. */
const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3700';

/**
 * The driver named by `RESET_MAILER`. Writing a second one against
 * `ResetMailer` is the only change a real deployment needs, and an unset
 * variable refuses at the moment somebody asks for a link rather than writing
 * it to a directory nobody reads — see `src/auth/mailer.ts`.
 */
const mailer = configuredMailer();

export type ResetState = { error?: string; sent?: boolean } | undefined;

/**
 * One sentence, whatever happened.
 *
 * An address with no account, a deactivated one, and a clinical account that
 * never enrolled all land here. A reset form that distinguished them would be
 * the staff-list oracle the sign-in already closes, reopened on a page with no
 * password to type and no attempt counter.
 */
const SAME_ANSWER =
  'If that address has an account here, a link is on its way. It is good for 30 minutes '
  + 'and works once.';

export async function requestReset(_prev: ResetState, form: FormData): Promise<ResetState> {
  await requestPasswordReset(String(form.get('email') ?? ''), { ...deps, baseUrl, mailer });
  return { sent: true, error: undefined };
}

export const sentMessage = async () => SAME_ANSWER;

export async function submitResetCode(_prev: ResetState, form: FormData): Promise<ResetState> {
  const token = String(form.get('token') ?? '');
  const result = await submitResetSecondFactor(token, String(form.get('code') ?? ''), deps);
  if (!result.ok) {
    if (result.reason === 'no_reset') redirect('/reset?expired=1');
    // A replayed code and a mistyped one get the same sentence here, exactly
    // as they do at the sign-in: the difference belongs in the audit trail, not
    // in front of somebody who might be holding a captured code and learning
    // whether it has been spent.
    return { error: 'That code is not right. Codes change every 30 seconds — try the one showing now.' };
  }
  // Re-render the same route; `resolveReset` now reports `set_password`.
  redirect(`/reset/${token}`);
}

export async function submitNewPassword(_prev: ResetState, form: FormData): Promise<ResetState> {
  const token = String(form.get('token') ?? '');
  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('confirm') ?? '')) {
    return { error: 'Those two do not match.' };
  }

  const result = await completeReset(token, password, deps);
  if (!result.ok) {
    if (result.reason === 'weak') return { error: result.complaint };
    // `second_factor_required` reaching here means the code was proved and then
    // un-proved — an administrator clearing the factor mid-flow. Both it and an
    // expired link go back to the start, which is where the remedy is.
    redirect('/reset?expired=1');
  }
  redirect('/login?reset=1');
}
