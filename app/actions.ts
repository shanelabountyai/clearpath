'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { BREAK_GLASS_COOKIE, USER_COOKIE, requireSession } from '../src/session';
import { auditEvent } from '../src/auth/guard';
import {
  isBreakGlassRef, isBreakGlassReason, serialiseBreakGlass,
} from '../src/auth/break-glass';

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

/**
 * Open a break-glass session. The reason is required, it is attached to every
 * audit row written while it is open, and opening it is itself logged.
 *
 * The reason is a code, and an unknown one opens nothing. It used to be a
 * textarea with a ten-character minimum, which bought the access for any
 * sentence at all — including the one the placeholder suggested, which named a
 * client's state of mind and would have gone into an append-only table the
 * auditor reads.
 */
export async function startBreakGlass(formData: FormData) {
  const reason = String(formData.get('reason') ?? '');
  if (!isBreakGlassReason(reason)) return;

  const rawRef = String(formData.get('ref') ?? '').trim();
  // Absent is fine; present and the wrong shape is not, because the shape is
  // the only thing keeping prose out of this field.
  if (rawRef && !isBreakGlassRef(rawRef)) return;
  const breakGlass = rawRef ? { reason, ref: rawRef } : { reason };

  const { actor } = await requireSession();
  const jar = await cookies();
  jar.set(BREAK_GLASS_COOKIE, serialiseBreakGlass(breakGlass), {
    httpOnly: true, sameSite: 'lax', path: '/',
  });

  await auditEvent({ ...actor, breakGlass }, 'read', 'client', { rule: 'breakGlass' });
  revalidatePath('/', 'layout');
}

export async function endBreakGlass() {
  const jar = await cookies();
  jar.delete(BREAK_GLASS_COOKIE);
  revalidatePath('/', 'layout');
}
