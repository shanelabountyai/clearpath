'use server';

import { redirect } from 'next/navigation';
import { systemClock } from '../../src/clock';
import { MAX_CODE_ATTEMPTS, acceptInvitation } from '../../src/auth/accounts';

/**
 * Claiming an account, and the thing this deliberately does not do.
 *
 * Like the reset flow, it touches no session cookie. Accepting an invitation
 * sets a password and sends the person to the front door, which for a clinical
 * role is where mandatory enrolment happens — so the second factor this flow
 * never asked for is demanded on the very next screen, before the account can
 * reach anything at all. A flow that handed back a session here would make the
 * link plus the code worth a *clinical session* rather than worth a password,
 * and the code is not a second factor: it is the other half of one credential
 * that was split when it was issued.
 */

const deps = { clock: systemClock };

export type InviteState = { error?: string } | undefined;

export async function claimAccount(_prev: InviteState, form: FormData): Promise<InviteState> {
  const token = String(form.get('token') ?? '');
  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('confirm') ?? '')) {
    return { error: 'Those two do not match.' };
  }

  const result = await acceptInvitation(token, String(form.get('code') ?? ''), password, deps);
  if (result.ok) redirect('/login?claimed=1');

  if (result.reason === 'weak') return { error: result.complaint };
  if (result.reason === 'no_invitation') redirect('/invite?expired=1');

  // The count is shown rather than hidden. Somebody mistyping a code read to
  // them over the phone has to know that the invitation is about to die and a
  // sixth attempt is not available — a silent burn gets reported as "the link
  // stopped working", and the practice manager re-issues into the same
  // confusion.
  return {
    error: result.attemptsLeft > 0
      ? `That code is not right. ${result.attemptsLeft} of ${MAX_CODE_ATTEMPTS} attempts left — `
        + 'ask whoever set up your account to read it out again.'
      : 'That invitation is now closed. Ask the practice manager to send a new one.',
  };
}
