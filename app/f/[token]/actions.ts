'use server';

import { redirect } from 'next/navigation';
import { saveDraft, submitForm } from '../../../src/forms/service';
import { Conflict } from '../../../src/errors';

/**
 * The client-facing door. No session, no actor from a cookie — the token is the
 * whole authorization, and the service checks its expiry and single use.
 */
export async function saveProgress(token: string, answers: Record<string, unknown>) {
  await saveDraft(token, answers);
}

/**
 * Returns a code, never the service's own message.
 *
 * A `Conflict` message is written for a log and whoever reads it: it names
 * template keys and versions, and it is in English whatever the client reads.
 * Handing one to the browser was a small wrong shape while there was one
 * language, and a disclosure-and-comprehension bug once there were two. The
 * caller looks the code up in `UI.errors`.
 */
export async function submit(
  token: string,
  answers: Record<string, unknown>,
): Promise<{ code: ClientErrorCode | null }> {
  try {
    await submitForm(token, answers);
  } catch (e) {
    if (e instanceof Conflict) return { code: isClientErrorCode(e.code) ? e.code : 'unknown' };
    throw e;
  }
  redirect(`/f/${token}/done`);
}

type ClientErrorCode = 'already_submitted' | 'expired' | 'invalid' | 'unknown';

const CLIENT_ERROR_CODES: readonly string[] = ['already_submitted', 'expired', 'invalid', 'unknown'];

/**
 * Anything the client door was not designed to explain becomes `unknown`.
 * A new `Conflict` code added elsewhere in the service must not leak its
 * internal name onto a client's screen just because nobody updated this list.
 */
const isClientErrorCode = (code: string | undefined): code is ClientErrorCode =>
  code !== undefined && CLIENT_ERROR_CODES.includes(code);
