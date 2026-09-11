'use server';

import { redirect } from 'next/navigation';
import { systemClock } from '@/src/clock';
import { requireSession } from '@/src/session';
import { cancelLeave, createLeave, decideCoverage, editLeaveDates, nameCoverer } from '@/src/staff/leave-plan';
import { addDays, localDateOf } from '@/src/time';
import { orBack } from '../departures/ui';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function recordLeave(f: FormData) {
  const { actor } = await requireSession();
  const leave = await orBack('/leave', () => createLeave(actor, {
    userId: str(f, 'userId'),
    fromDate: str(f, 'fromDate'),
    toDate: str(f, 'toDate'),
    coveringClinicianId: str(f, 'coveringClinicianId'),
  }));
  redirect(`/leave/${leave.id}`);
}

export async function chooseCoverer(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  await orBack(`/leave/${id}`, () => nameCoverer(actor, id, str(f, 'coveringClinicianId')));
  redirect(`/leave/${id}`);
}

export async function decideClient(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  await orBack(`/leave/${id}`, () => decideCoverage(actor, id, {
    clientId: str(f, 'clientId'), coveringClinicianId: str(f, 'coveringClinicianId'),
  }));
  redirect(`/leave/${id}`);
}

export async function moveDates(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  await orBack(`/leave/${id}`, () => editLeaveDates(actor, id, { fromDate: str(f, 'fromDate'), toDate: str(f, 'toDate') }));
  redirect(`/leave/${id}`);
}

/** D-18: "back today" is the last day moved to yesterday, decided on the server's clock, not the page's. */
export async function backToday(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  const yesterday = addDays(localDateOf(systemClock.now()), -1);
  await orBack(`/leave/${id}`, () => editLeaveDates(actor, id, { fromDate: str(f, 'fromDate'), toDate: yesterday }));
  redirect(`/leave/${id}`);
}

export async function cancel(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  await orBack(`/leave/${id}`, () => cancelLeave(actor, id));
  redirect(`/leave/${id}`);
}
