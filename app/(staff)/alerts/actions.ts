'use server';

import { revalidatePath } from 'next/cache';
import { acknowledgeAlert } from '../../../src/forms/service';
import { requireSession } from '../../../src/session';

export async function acknowledge(formData: FormData) {
  const { actor } = await requireSession();
  await acknowledgeAlert(actor, String(formData.get('alertId')));
  revalidatePath('/alerts');
}
