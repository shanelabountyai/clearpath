'use server';

import { redirect } from 'next/navigation';
import { Conflict } from '../../../src/errors';
import {
  confirmAppointment, declineAppointment, requestReschedule, type RescheduleReason,
} from '../../../src/portal/service';

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

/**
 * "Yes, I am coming."
 *
 * Tapping it twice is the same answer both times, so the button never needs to
 * be disabled and a duplicated message never produces a second confirmation.
 */
export async function sayYes(formData: FormData) {
  const token = String(formData.get('token'));
  const appointmentId = String(formData.get('appointmentId'));

  try {
    await confirmAppointment(token, appointmentId);
  } catch {
    redirect(`/p/${token}`);
  }
  redirect(`/p/${token}?confirmed=1`);
}

/**
 * "No, I cannot make it." Two taps when it is chargeable, one when it is not.
 *
 * The first tap does not know which it is — the server decides from the clock,
 * the same way it decides whether front desk's cancellation was late — and
 * answers with the interstitial when a fee applies. Nothing has been cancelled
 * at that point; the redirect is a question, not a receipt.
 */
export async function sayNo(formData: FormData) {
  const token = String(formData.get('token'));
  const appointmentId = String(formData.get('appointmentId'));
  const acknowledgeFee = formData.get('acknowledgeFee') === '1';

  try {
    await declineAppointment(token, appointmentId, { acknowledgeFee });
  } catch (e) {
    if (e instanceof Conflict && e.code === 'fee_acknowledgement_required') {
      redirect(`/p/${token}?fee=${appointmentId}`);
    }
    redirect(`/p/${token}`);
  }
  redirect(`/p/${token}?declined=1`);
}
