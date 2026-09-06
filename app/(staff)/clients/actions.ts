'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { setFee, updateClient } from '../../../src/clients/repository';
import { LANGUAGES, type Language } from '../../../src/messaging/language';
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
 * How this client is contacted: the channel, the cadence and the language.
 *
 * One form because it is one decision, and one guard because the dangerous half
 * is the channel. `none` is not "fewer messages" — it is the safety setting,
 * and it carries an exemption from the fee, which is why it stays here on a
 * staff screen and is the one value the client's own door may never reach.
 *
 * An unrecognised value is dropped rather than defaulted, in every field.
 * Silently writing `full` for a bad post would be the one direction that sends
 * a client *more* messages than anybody chose, and silently writing `email`
 * would take somebody off `none` — which is the setting people are on because
 * a message on the wrong phone is a danger rather than an annoyance.
 */
export async function saveContactPreferences(formData: FormData) {
  const { actor } = await requireSession();
  const clientId = String(formData.get('clientId'));

  // Each field is validated and applied on its own, and an absent one is left
  // alone rather than defaulted. That independence is the fix for a real bug:
  // the cadence select is not rendered for a client on `none` — there is no
  // cadence when nothing is sent — so a form that required it would silently
  // drop the very submission that turns their messages back on.
  const rawCadence = String(formData.get('reminderCadence') ?? '');
  const reminderCadence = (CADENCES as readonly string[]).includes(rawCadence)
    ? (rawCadence as ReminderCadence)
    : undefined;

  const rawLanguage = String(formData.get('language') ?? '');
  const language = (LANGUAGES as readonly string[]).includes(rawLanguage)
    ? (rawLanguage as Language)
    : undefined;

  // The channel. Dropped rather than defaulted for the reason above: there is
  // no safe value to guess when the wrong guess is "start messaging them".
  const rawChannel = String(formData.get('reminderPreference') ?? '');
  const reminderPreference = (['email', 'sms', 'none'] as const).find((c) => c === rawChannel);

  if (!reminderCadence && !language && !reminderPreference) return;

  await updateClient(actor, clientId, {
    ...(reminderCadence ? { reminderCadence } : {}),
    ...(language ? { language } : {}),
    ...(reminderPreference ? { reminderPreference } : {}),
  });
  revalidatePath(`/clients/${clientId}`);
}
