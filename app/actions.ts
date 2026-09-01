'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { BREAK_GLASS_COOKIE, USER_COOKIE, requireSession } from '../src/session';
import { auditEvent } from '../src/auth/guard';

/** Dev-mode identity switch. The seam where real authentication would go. */
export async function switchUser(formData: FormData) {
  const id = String(formData.get('userId') ?? '');
  const jar = await cookies();
  jar.set(USER_COOKIE, id, { httpOnly: true, sameSite: 'lax', path: '/' });
  // Switching identity always drops break-glass. Carrying an emergency
  // justification across a change of person is exactly the accident the
  // required-reason field exists to prevent.
  jar.delete(BREAK_GLASS_COOKIE);
  revalidatePath('/', 'layout');
}

export async function signOut() {
  const jar = await cookies();
  jar.delete(USER_COOKIE);
  jar.delete(BREAK_GLASS_COOKIE);
  redirect('/');
}

/**
 * Open a break-glass session. The reason is required, it is attached to every
 * audit row written while it is open, and opening it is itself logged.
 */
export async function startBreakGlass(formData: FormData) {
  const reason = String(formData.get('reason') ?? '').trim();
  // Server-side too, not just the form's `required`: this is a trust boundary,
  // and a reason of "." would otherwise buy the same access as a real one.
  if (reason.length < 10) return;

  const { actor } = await requireSession();
  const jar = await cookies();
  jar.set(BREAK_GLASS_COOKIE, reason, { httpOnly: true, sameSite: 'lax', path: '/' });

  await auditEvent({ ...actor, breakGlass: { reason } }, 'read', 'client', { rule: 'breakGlass' });
  revalidatePath('/', 'layout');
}

export async function endBreakGlass() {
  const jar = await cookies();
  jar.delete(BREAK_GLASS_COOKIE);
  revalidatePath('/', 'layout');
}
