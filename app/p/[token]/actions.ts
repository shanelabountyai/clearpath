'use server';

import { redirect } from 'next/navigation';
import { requestReschedule, type RescheduleReason } from '../../../src/portal/service';

/**
 * The one thing a client can write.
 *
 * No session, no actor lookup: the token is the whole authorization, exactly as
 * on the form door. It reaches one appointment belonging to one client, and it
 * creates a request rather than changing anything.
 */
export async function askToReschedule(formData: FormData) {
  const token = String(formData.get('token'));
  const appointmentId = String(formData.get('appointmentId'));
  const reason = String(formData.get('reason')) as RescheduleReason;

  try {
    await requestReschedule(token, appointmentId, reason);
  } catch {
    // A bad token or a stale appointment tells the client nothing new — the page
    // re-renders from what the token can actually see.
    redirect(`/p/${token}`);
  }

  redirect(`/p/${token}?asked=1`);
}
