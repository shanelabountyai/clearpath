'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { systemClock } from '../../../src/clock';
import { clearSecondFactor } from '../../../src/auth/recovery';
import { createAccount, reissueInvitation, setAccountActive } from '../../../src/auth/accounts';
import type { Role } from '../../../src/auth/permissions';
import { Conflict } from '../../../src/errors';

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

/**
 * Making an account exist, and the two halves that come back from it.
 *
 * The code is returned to this screen and rendered once. That is the entire
 * mechanism: the practice manager is the second channel, and the value of the
 * split depends on the code not travelling by the same route as the link. So it
 * is never mailed, never put in a URL, and never written to `OutboxMessage` —
 * which stores `body`, and which the confirmation report, the work lists and the
 * delivery job all read.
 *
 * Authorization is `createAccount`'s, through the matrix. A form post from
 * somebody who is not the practice manager lands on the same guard and leaves
 * the same denial row.
 */
export type AccountState =
  | { error: string }
  | { invitation: { name: string; email: string; link: string; code: string } }
  | undefined;

const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3700';
const issueDeps = { clock: systemClock, baseUrl };

/** A refusal from the domain, as the sentence it already wrote. */
function refusal(error: unknown): AccountState {
  if (error instanceof Conflict) return { error: error.message };
  throw error;
}

export async function createAccountAction(_prev: AccountState, form: FormData): Promise<AccountState> {
  const { actor } = await requireSession();
  const email = String(form.get('email') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();

  try {
    const invitation = await createAccount(actor, {
      name,
      email,
      role: String(form.get('role') ?? '') as Role,
      supervisorId: String(form.get('supervisorId') ?? '') || null,
    }, issueDeps);
    revalidatePath('/practice');
    return { invitation: { name, email, link: invitation.link, code: invitation.code } };
  } catch (error) {
    return refusal(error);
  }
}

export async function reissueInvitationAction(_prev: AccountState, form: FormData): Promise<AccountState> {
  const { actor } = await requireSession();
  const userId = String(form.get('userId') ?? '');
  try {
    const invitation = await reissueInvitation(actor, userId, issueDeps);
    revalidatePath('/practice');
    return {
      invitation: {
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        link: invitation.link,
        code: invitation.code,
      },
    };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * Somebody leaving, or coming back.
 *
 * No returned state, because there is nothing to show: this one is a plain form
 * post. Deactivating ends their live sessions in the same transaction — a
 * person who has left the practice should not keep a client's record open on
 * the way out of the building — and it revokes whatever invitation or reset
 * link was in flight, so coming back is a fresh decision rather than a resumed
 * one.
 */
export async function setAccountActiveAction(form: FormData): Promise<void> {
  const { actor } = await requireSession();
  await setAccountActive(
    actor,
    String(form.get('userId') ?? ''),
    form.get('active') === 'true',
    { clock: systemClock },
  );
  revalidatePath('/practice');
}
