'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Conflict } from '../../src/errors';
import { submitPublicInquiry, type PublicInquiryRefusal } from '../../src/clients/public-inquiry';

/**
 * The public door. No session, no actor from a cookie, no token — this is the
 * one surface in the application reached by somebody the practice has never
 * heard of, and `submitPublicInquiry` is where that stops being unlimited.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const orNull = (f: FormData, k: string) => str(f, k) || null;

/**
 * Whoever the proxy says is asking.
 *
 * Spoofable — `x-forwarded-for` is a header, and a determined attacker rotates
 * it — which is why it is a hash key for a spam ceiling and never an identity.
 * Falling back to one shared bucket is the safe direction: an unattributable
 * request is throttled alongside every other unattributable request rather than
 * escaping the limit entirely.
 */
async function submitterAddress(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || h.get('x-real-ip') || 'unknown';
}

const REFUSALS: readonly string[] = ['closed', 'too_many', 'invalid'];

export async function enquire(formData: FormData) {
  const lang = str(formData, 'lang') === 'es' ? 'es' : 'en';
  const query = (params: Record<string, string>) =>
    new URLSearchParams({ ...(lang === 'es' ? { lang } : {}), ...params }).toString();

  try {
    await submitPublicInquiry(
      {
        firstName: str(formData, 'firstName'),
        lastName: str(formData, 'lastName'),
        email: orNull(formData, 'email'),
        phone: orNull(formData, 'phone'),
        requestedClinicianId: orNull(formData, 'requestedClinicianId'),
        referralSource: str(formData, 'referralSource'),
        website: orNull(formData, 'website'),
      },
      { address: await submitterAddress() },
    );
  } catch (e) {
    // `redirect` throws, so it must not be inside this try.
    if (!(e instanceof Conflict)) throw e;
    const code: PublicInquiryRefusal | 'unknown' =
      REFUSALS.includes(e.code ?? '') ? (e.code as PublicInquiryRefusal) : 'unknown';
    redirect(`/enquire?${query({ e: code })}`);
  }

  // The same page a caught robot is sent to, and the same page somebody who
  // enquired twice would reach. It says nothing about what the practice did
  // with the message, because a page that did would be a way to ask.
  redirect(`/enquire/done?${query({})}`);
}
