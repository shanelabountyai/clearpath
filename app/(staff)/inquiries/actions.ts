'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '../../../src/session';
import { Conflict } from '../../../src/errors';
import { issueForm } from '../../../src/forms/service';
import {
  convertInquiry, createInquiry, discardInquiry,
  type DiscardReason, type ReferralSource,
} from '../../../src/clients/inquiry';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const orNull = (f: FormData, k: string) => str(f, k) || null;

export async function recordInquiry(formData: FormData) {
  const { actor } = await requireSession();
  await createInquiry(actor, {
    firstName: str(formData, 'firstName'),
    lastName: str(formData, 'lastName'),
    phone: orNull(formData, 'phone'),
    email: orNull(formData, 'email'),
    requestedClinicianId: orNull(formData, 'requestedClinicianId'),
    referralSource: str(formData, 'referralSource') as ReferralSource,
    referralNote: orNull(formData, 'referralNote'),
    note: orNull(formData, 'note'),
  });
  revalidatePath('/inquiries');
}

export async function discard(formData: FormData) {
  const { actor } = await requireSession();
  await discardInquiry(actor, str(formData, 'id'), str(formData, 'reason') as DiscardReason);
  revalidatePath('/inquiries');
}

/**
 * Convert, then send the packet — two acts, two outcomes, in that order.
 *
 * `issueForm` refuses a template the client cannot read in their language, and
 * that refusal belongs in front of the person who clicked rather than inside
 * the conversion. So both outcomes come back to this page: the client exists
 * either way, and a failed send is a sentence saying the packet is what still
 * needs doing, not a crash that leaves them guessing whether the client landed.
 */
export async function convert(formData: FormData) {
  const { actor } = await requireSession();
  const id = str(formData, 'id');
  const back = (params: Record<string, string>) =>
    redirect(`/inquiries?${new URLSearchParams(params)}`);

  let clientId: string;
  try {
    const client = await convertInquiry(actor, id, {
      code: str(formData, 'code'),
      dateOfBirth: new Date(str(formData, 'dateOfBirth')),
      treatingClinicianId: str(formData, 'treatingClinicianId'),
      language: str(formData, 'language') === 'es' ? 'es' : 'en',
    });
    clientId = client.id;
  } catch (e) {
    if (e instanceof Conflict) back({ convert: id, error: e.message });
    throw e;
  }

  const templateKey = str(formData, 'templateKey');
  if (!templateKey) back({ converted: clientId });

  try {
    await issueForm(actor, { clientId, templateKey });
  } catch (e) {
    if (e instanceof Conflict) back({ converted: clientId, sendFailed: e.message });
    throw e;
  }
  back({ converted: clientId, sent: templateKey });
}
