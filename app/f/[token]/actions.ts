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

export async function submit(token: string, answers: Record<string, unknown>): Promise<{ error: string | null }> {
  try {
    await submitForm(token, answers);
  } catch (e) {
    if (e instanceof Conflict) return { error: e.message };
    throw e;
  }
  redirect(`/f/${token}/done`);
}
