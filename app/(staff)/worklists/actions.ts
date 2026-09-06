'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../src/session';
import { resolveRescheduleRequest } from '../../../src/portal/service';
import { resolveInboundReply } from '../../../src/messaging/inbound';

export async function handleRescheduleRequest(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('requestId'));
  const status = formData.get('status') === 'declined' ? 'declined' : 'handled';
  await resolveRescheduleRequest(actor, id, status);
  revalidatePath('/worklists');
}

export async function markInboundHandled(formData: FormData) {
  const { actor } = await requireSession();
  await resolveInboundReply(actor, String(formData.get('replyId')));
  revalidatePath('/worklists');
}
