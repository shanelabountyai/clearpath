'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '../../../src/session';
import { Conflict } from '../../../src/errors';
import { issueForm } from '../../../src/forms/service';
import {
  assignInquiry, convertInquiry, createInquiry, createReferrer, discardInquiry,
  setCapacity, setReferrerActive,
  type DiscardReason, type ReferralSource,
} from '../../../src/clients/inquiry';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const orNull = (f: FormData, k: string) => str(f, k) || null;

/**
 * Record the call, then look for a client we may already have.
 *
 * In that order, and never the reverse: the duplicate check is a warning the
 * page draws afterwards (P1-2), not a gate the caller waits behind.
 */
export async function recordInquiry(formData: FormData) {
  const { actor } = await requireSession();
  const inquiry = await createInquiry(actor, {
    firstName: str(formData, 'firstName'),
    lastName: str(formData, 'lastName'),
    phone: orNull(formData, 'phone'),
    email: orNull(formData, 'email'),
    requestedClinicianId: orNull(formData, 'requestedClinicianId'),
    referralSource: str(formData, 'referralSource') as ReferralSource,
    referralNote: orNull(formData, 'referralNote'),
    // Kept only when the source is `gp` — `createInquiry` drops it otherwise,
    // and the database refuses the row that disagrees. The form cannot hide
    // this picker without JavaScript, so the shaping happens server-side.
    referrerId: orNull(formData, 'referrerId'),
    note: orNull(formData, 'note'),
  });
  redirect(`/inquiries?recorded=${inquiry.id}`);
}

export async function discard(formData: FormData) {
  const { actor } = await requireSession();
  await discardInquiry(actor, str(formData, 'id'), str(formData, 'reason') as DiscardReason, {
    // Only lands on a `referred_out` discard; ignored on every other reason.
    referredOutToId: orNull(formData, 'referredOutToId'),
  });
  revalidatePath('/inquiries');
}

/**
 * Add a surgery to the directory, mid-call.
 *
 * `referrer: create`, a cell front desk and every clinician hold and the
 * public form deliberately does not — the anonymous internet may leave an
 * enquiry, not append to a list the whole practice reads.
 */
export async function addReferrer(formData: FormData) {
  const { actor } = await requireSession();
  await createReferrer(actor, {
    practice: str(formData, 'practice'),
    name: orNull(formData, 'name'),
    phone: orNull(formData, 'phone'),
    email: orNull(formData, 'email'),
  });
  revalidatePath('/inquiries');
}

/** Retire one, or bring it back. Never a delete — enquiries point at it. */
export async function toggleReferrer(formData: FormData) {
  const { actor } = await requireSession();
  await setReferrerActive(actor, str(formData, 'id'), str(formData, 'active') === 'yes');
  revalidatePath('/inquiries');
}

/**
 * Put a call in a clinician's queue, or take it back out.
 *
 * An empty select is `null`, not a no-op: unassigning is a real act — a
 * clinician handing a call back is the thing the queue exists to make visible.
 */
export async function assign(formData: FormData) {
  const { actor } = await requireSession();
  await assignInquiry(actor, str(formData, 'id'), orNull(formData, 'clinicianId'));
  revalidatePath('/inquiries');
}

/**
 * Say whether you can take somebody new. No subject in the form — `setCapacity`
 * takes it from the session, so there is nothing here for a hand-rolled POST to
 * point at somebody else.
 */
export async function setAccepting(formData: FormData) {
  const { actor } = await requireSession();
  await setCapacity(actor, str(formData, 'accepting') === 'yes');
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
    if (e instanceof Conflict) back({ convert: id, error: e.code ?? 'conflict' });
    throw e;
  }

  const templateKey = str(formData, 'templateKey');
  if (!templateKey) back({ converted: clientId });

  try {
    await issueForm(actor, { clientId, templateKey });
  } catch (e) {
    if (e instanceof Conflict) back({ converted: clientId, sendFailed: e.code ?? 'conflict' });
    throw e;
  }
  back({ converted: clientId, sent: templateKey });
}
