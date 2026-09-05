'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { resolveRescheduleRequest } from '../../../src/portal/service';
import { markReplyHandled } from '../../../src/messaging/inbound';

export async function handleRescheduleRequest(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('requestId'));
  const status = formData.get('status') === 'declined' ? 'declined' : 'handled';
  await resolveRescheduleRequest(actor, id, status);
  revalidatePath('/worklists');
}

/**
 * P1-3. "I rang them." There is nothing to read and nothing to reply to — the
 * only thing this button records is that a person made the call.
 */
export async function handleInboundReplyCall(formData: FormData) {
  const { actor } = await requireSession();
  await markReplyHandled(actor, String(formData.get('replyId')));
  revalidatePath('/worklists');
}
