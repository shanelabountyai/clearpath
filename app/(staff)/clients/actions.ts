'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { setFee, updateClient } from '../../../src/clients/repository';
import { issueForm } from '../../../src/forms/service';
import { createProcessNote } from '../../../src/notes/service';

export async function saveClient(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('clientId'));
  await updateClient(actor, id, {
    phone: String(formData.get('phone') ?? '') || null,
    email: String(formData.get('email') ?? '') || null,
    emergencyContactName: String(formData.get('emergencyContactName') ?? '') || null,
    emergencyContactPhone: String(formData.get('emergencyContactPhone') ?? '') || null,
    reminderPreference: String(formData.get('reminderPreference') ?? 'email') as 'email' | 'sms' | 'none',
  });
  revalidatePath(`/clients/${id}`);
}

export async function saveFee(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('clientId'));
  const raw = String(formData.get('feeDollars') ?? '').trim();
  // Money is integer cents everywhere inside the app; the form is the only
  // place dollars exist, and it converts once, here.
  await setFee(actor, id, raw === '' ? null : Math.round(Number(raw) * 100));
  revalidatePath(`/clients/${id}`);
}

export async function sendForm(formData: FormData) {
  const { actor } = await requireSession();
  const clientId = String(formData.get('clientId'));
  await issueForm(actor, { clientId, templateKey: String(formData.get('templateKey')) });
  revalidatePath(`/clients/${clientId}`);
}

export async function addProcessNote(formData: FormData) {
  const { actor } = await requireSession();
  const clientId = String(formData.get('clientId'));
  const content = String(formData.get('content') ?? '').trim();
  if (content) await createProcessNote(actor, { clientId, content });
  revalidatePath(`/clients/${clientId}`);
}
