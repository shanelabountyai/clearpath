'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '../../../src/session';
import { cancelAppointment, setStatus, waiveFee, type FeeWaiveReason, type Status } from '../../../src/scheduling/lifecycle';
import { rescheduleAppointment } from '../../../src/scheduling/booking';
import { createProgressNote } from '../../../src/notes/service';
import { Conflict } from '../../../src/errors';

export async function advanceStatus(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('appointmentId'));
  await setStatus(actor, id, String(formData.get('to')) as Status);
  revalidatePath(`/appointments/${id}`);
}

export async function cancelSession(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('appointmentId'));
  await cancelAppointment(actor, id, { reason: String(formData.get('reason') ?? '') || undefined });
  revalidatePath(`/appointments/${id}`);
}

/**
 * P0-7. Authorization is not decided here — `waiveFee` goes through the
 * matrix's one `fee: waive` cell, so front desk submitting this form by hand
 * gets a 403 and a logged denial rather than a hidden button being the whole
 * of the policy.
 */
export async function waiveSessionFee(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('appointmentId'));
  try {
    await waiveFee(actor, id, String(formData.get('reason')) as FeeWaiveReason);
  } catch (e) {
    if (e instanceof Conflict) redirect(`/appointments/${id}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath(`/appointments/${id}`);
}

export async function moveSession(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('appointmentId'));
  try {
    await rescheduleAppointment(actor, id, {
      date: String(formData.get('date')),
      startMinute: Number(formData.get('startMinute')),
    });
  } catch (e) {
    if (e instanceof Conflict) redirect(`/appointments/${id}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath(`/appointments/${id}`);
}

export async function startProgressNote(formData: FormData) {
  const { actor } = await requireSession();
  const appointmentId = String(formData.get('appointmentId'));
  const note = await createProgressNote(actor, { appointmentId, content: '' });
  redirect(`/notes/${note.id}`);
}
