'use server';

import { redirect } from 'next/navigation';
import { Conflict } from '../../../src/errors';
import { requireSession } from '../../../src/session';
import { bookGroupSession, cancelGroupSession } from '../../../src/scheduling/groups';
import { queueToClient } from '../../../src/messaging/outbox';
import { systemClock } from '@/src/clock';
import type { AppointmentType } from '../../../src/scheduling/recurrence';

export async function bookGroup(formData: FormData) {
  const { actor } = await requireSession();

  const clinicianId = String(formData.get('clinicianId'));
  const date = String(formData.get('date'));
  const startMinute = Number(formData.get('startMinute'));
  const type = String(formData.get('type') ?? 'standard') as AppointmentType;
  const modality = String(formData.get('modality') ?? 'in_person') as 'in_person' | 'telehealth';
  const topic = String(formData.get('topic') ?? '').trim() || null;
  const clientIds = formData.getAll('clientIds').map(String).filter(Boolean);

  const back = (params: Record<string, string>) =>
    redirect(`/book/group?${new URLSearchParams({ clinicianId, date, type, modality, ...params })}`);

  if (clientIds.length === 0) back({ error: 'Choose at least one attendee' });

  let groupId: string;
  try {
    const group = await bookGroupSession(actor, {
      clinicianId, clientIds, date, startMinute, type, modality, topic,
    });
    groupId = group.id;
    // One message each, exactly as an individual booking. Nothing in it names
    // the group or anyone else in it.
    for (const a of group.appointments) {
      await queueToClient({
        clientId: a.clientId,
        templateKey: 'appointment_confirmed',
        scheduledFor: systemClock.now(),
        startAt: a.startAt,
      });
    }
  } catch (e) {
    if (e instanceof Conflict) back({ error: e.message });
    throw e;
  }

  redirect(`/groups/${groupId}`);
}

export async function cancelGroup(formData: FormData) {
  const { actor } = await requireSession();
  const groupId = String(formData.get('groupId'));
  await cancelGroupSession(actor, groupId, { reason: 'session cancelled' });
  redirect(`/groups/${groupId}`);
}
