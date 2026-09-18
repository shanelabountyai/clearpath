'use server';

import { revalidatePath } from 'next/cache';
import { acknowledgeAlert, reopenAlert } from '../../../src/forms/service';
import { requireSession } from '../../../src/session';

export async function acknowledge(formData: FormData) {
  const { actor } = await requireSession();
  await acknowledgeAlert(actor, String(formData.get('alertId')));
  revalidatePath('/alerts');
}

export async function reopen(formData: FormData) {
  const { actor } = await requireSession();
  await reopenAlert(actor, String(formData.get('alertId')));
  revalidatePath('/alerts');
}
