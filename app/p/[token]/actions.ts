'use server';

import { redirect } from 'next/navigation';
import { Conflict } from '../../../src/errors';
import {
  chooseCadence, confirmAppointment, declineAppointment, requestReschedule,
  type RescheduleReason,
} from '../../../src/portal/service';
import { CADENCES, type ReminderCadence } from '../../../src/scheduling/confirmation';

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
  // P1-5. One of the four, and the same four the reschedule request uses.
  const reason = String(formData.get('reason') ?? 'cannot_make_it') as RescheduleReason;

  try {
    await declineAppointment(token, appointmentId, { acknowledgeFee, reason });
  } catch (e) {
    if (e instanceof Conflict && e.code === 'fee_acknowledgement_required') {
      // The reason survives the interstitial, so the second tap does not ask
      // the client the same question twice.
      redirect(`/p/${token}?fee=${appointmentId}&reason=${reason}`);
    }
    redirect(`/p/${token}`);
  }
  redirect(`/p/${token}?declined=1`);
}

/**
 * "Send me fewer of these."
 *
 * The only thing on this page that changes something about the client rather
 * than about one appointment. `chooseCadence` is the whole of what the token
 * may do to their record — the channel is not reachable from here, by the
 * matrix rather than by this function remembering not to.
 */
export async function chooseHowMany(formData: FormData) {
  const token = String(formData.get('token'));
  const raw = String(formData.get('reminderCadence') ?? '');
  if (!(CADENCES as readonly string[]).includes(raw)) redirect(`/p/${token}`);

  try {
    await chooseCadence(token, raw as ReminderCadence);
  } catch {
    redirect(`/p/${token}`);
  }
  redirect(`/p/${token}?cadence=1`);
}
