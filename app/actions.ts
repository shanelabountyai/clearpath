'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { BREAK_GLASS_COOKIE, USER_COOKIE, isSwitchable, openBreakGlass, requireSession } from '../src/session';
import { BREAK_GLASS_TTL } from '../src/break-glass-cookie';

/** Dev-mode identity switch. The seam where real authentication would go. */
export async function switchUser(formData: FormData) {
  const id = String(formData.get('userId') ?? '');
  // Only who the picker offers — not a client, not a deactivated user (SEC-03).
  if (!(await isSwitchable(id))) return;
  const jar = await cookies();
  jar.set(USER_COOKIE, id, { httpOnly: true, sameSite: 'lax', path: '/' });
  // Switching identity always drops break-glass. Carrying an emergency
  // justification across a change of person is exactly the accident the
  // required-reason field exists to prevent.
  jar.delete(BREAK_GLASS_COOKIE);
  revalidatePath('/', 'layout');
}

/**
 * Open a break-glass session. The reason is a code from a fixed list, it is
 * attached to every audit row written while it is open, and opening it is
 * itself logged — before the cookie is set.
 */
export async function startBreakGlass(formData: FormData) {
  const { actor } = await requireSession();
  const cookie = await openBreakGlass(actor, String(formData.get('reason') ?? ''));
  if (!cookie) return;
  const jar = await cookies();
  jar.set(BREAK_GLASS_COOKIE, cookie, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: BREAK_GLASS_TTL / 1000,
  });
  revalidatePath('/', 'layout');
}

export async function endBreakGlass() {
  const jar = await cookies();
  jar.delete(BREAK_GLASS_COOKIE);
  revalidatePath('/', 'layout');
}
