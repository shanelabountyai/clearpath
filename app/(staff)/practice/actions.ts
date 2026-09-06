'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { systemClock } from '../../../src/clock';
import { clearSecondFactor } from '../../../src/auth/recovery';

/**
 * The other half of "a reset needs the second factor".
 *
 * Requiring it means somebody who loses their password *and* their
 * authenticator cannot get back in by any route the system offers. That is the
 * correct security answer and an unacceptable operational one on its own, so
 * the way back is a person verifying a person — and what that person does here
 * is *clear* a factor, never see one and never set one. The owner enrols their
 * own authenticator on their next sign-in, which is the only version where the
 * person holding the factor is the person it is for.
 *
 * Authorization is `clearSecondFactor`'s, through the matrix, not this file's.
 * The button below it is only drawn for a role the matrix already allows, and
 * a form post from somebody else lands on the same guard and the same audit
 * row.
 */
export async function clearSecondFactorAction(form: FormData): Promise<void> {
  const { actor } = await requireSession();
  await clearSecondFactor(actor, String(form.get('userId') ?? ''), { clock: systemClock });
  revalidatePath('/practice');
}
