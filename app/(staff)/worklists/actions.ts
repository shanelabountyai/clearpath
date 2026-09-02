'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { resolveRescheduleRequest } from '../../../src/portal/service';

export async function handleRescheduleRequest(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('requestId'));
  const status = formData.get('status') === 'declined' ? 'declined' : 'handled';
  await resolveRescheduleRequest(actor, id, status);
  revalidatePath('/worklists');
}
