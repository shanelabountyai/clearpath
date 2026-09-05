'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { setFee, updateClient } from '../../../src/clients/repository';
import { CADENCES, type ReminderCadence } from '../../../src/scheduling/confirmation';
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
 * P2-3. How many of the three confirmation messages this client wants.
 *
 * A client tells the practice this on the phone or in the room — there is no
 * portal control for it, because the portal is a tokenized door with no login
 * behind it, and a forwarded link should not be able to change how somebody is
 * contacted. So it is a staff edit on the record, audited like any other.
 *
 * An unrecognised value is dropped rather than defaulted. Silently writing
 * `full` for a bad post would be the one direction that sends a client *more*
 * messages than anybody chose.
 */
export async function saveReminderCadence(formData: FormData) {
  const { actor } = await requireSession();
  const clientId = String(formData.get('clientId'));
  const raw = String(formData.get('reminderCadence') ?? '');
  if (!(CADENCES as readonly string[]).includes(raw)) return;

  await updateClient(actor, clientId, { reminderCadence: raw as ReminderCadence });
  revalidatePath(`/clients/${clientId}`);
}
