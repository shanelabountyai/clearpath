'use server';

import { randomUUID } from 'node:crypto';
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

/** What the person typed, handed back so a refusal does not erase it (PRD 4). */
const FIELDS = ['firstName', 'lastName', 'email', 'phone', 'requestedClinicianId', 'referralSource'] as const;
export type EnquireValues = Record<(typeof FIELDS)[number], string>;

/**
 * A refusal comes back as a code and the submitted values, never as a redirect.
 * A redirect is a navigation, and the only way to carry a name, an email and a
 * phone number across one is the URL, which hard rule 3 forbids. The values
 * travel in the response body instead, to the person who just typed them. The
 * honeypot is left out, because nobody who can see the form filled it in.
 *
 * `id` is new on every refusal and keys the form, so it remounts with the
 * returned values. Otherwise React's reset after an action puts every select
 * back to its first option, even though the text inputs survive.
 */
export type EnquireState = { id: string; code: PublicInquiryRefusal | 'unknown'; values: EnquireValues } | null;

export async function enquire(_prev: EnquireState, formData: FormData): Promise<EnquireState> {
  const lang = str(formData, 'lang') === 'es' ? 'es' : 'en';

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
    if (!(e instanceof Conflict)) throw e;
    return {
      id: randomUUID(),
      code: REFUSALS.includes(e.code ?? '') ? (e.code as PublicInquiryRefusal) : 'unknown',
      values: Object.fromEntries(FIELDS.map((k) => [k, String(formData.get(k) ?? '')])) as EnquireValues,
    };
  }

  // The same page a caught robot is sent to, and the same page somebody who
  // enquired twice would reach. It says nothing about what the practice did
  // with the message, because a page that did would be a way to ask.
  redirect(`/enquire/done${lang === 'es' ? '?lang=es' : ''}`);
}
