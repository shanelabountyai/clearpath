'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { setFee, updateClient } from '../../../src/clients/repository';
import { issueForm } from '../../../src/forms/service';
import { createProcessNote } from '../../../src/notes/service';
import { issuePortalLink } from '../../../src/portal/service';

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

/** Send the client their own link to their schedule. */
export async function sendPortalLink(formData: FormData) {
  const { actor } = await requireSession();
  const clientId = String(formData.get('clientId'));
  await issuePortalLink(actor, { clientId });
  revalidatePath(`/clients/${clientId}`);
}

/**
 * Which stages this client is asked at. No boxes ticked means the practice
 * cadence, which is the normal state and the one the streak cap still applies
 * to — so "clear the selection" and "follow the practice" are the same gesture
 * rather than two settings that can disagree.
 */
export async function saveReminderStages(formData: FormData) {
  const { actor } = await requireSession();
  const clientId = String(formData.get('clientId'));
  const picked = formData.getAll('stages').map(String);
  const stages = (['d5', 'd1', 'd0'] as const).filter((s) => picked.includes(s));
  await updateClient(actor, clientId, { reminderStages: [...stages] });
  revalidatePath(`/clients/${clientId}`);
}
