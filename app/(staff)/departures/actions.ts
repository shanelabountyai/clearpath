'use server';

import { redirect } from 'next/navigation';
import { requireSession } from '@/src/session';
import {
  cancelDeparture, decideAssignment, executeDeparture, planDeparture, setReceivingSupervisor,
  type Disposition,
} from '@/src/staff/departure';
import { orBack } from './ui';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const orNull = (f: FormData, k: string) => str(f, k) || null;

export async function recordNotice(f: FormData) {
  const { actor } = await requireSession();
  const d = await orBack('/departures', () => planDeparture(actor, {
    userId: str(f, 'userId'),
    lastDayOn: str(f, 'lastDayOn'),
    receivingSupervisorId: orNull(f, 'receivingSupervisorId') ?? undefined,
  }));
  redirect(`/departures/${d.id}`);
}

export async function decide(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  await orBack(`/departures/${id}`, () => decideAssignment(actor, id, {
    clientId: str(f, 'clientId'),
    disposition: str(f, 'disposition') as Disposition,
    // Both ride on every row's form; `decideAssignment` keeps only the one the
    // disposition names.
    receivingClinicianId: orNull(f, 'receivingClinicianId'),
    referredOutToId: orNull(f, 'referredOutToId'),
  }));
  redirect(`/departures/${id}`);
}

export async function chooseSupervisor(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  await orBack(`/departures/${id}`, () => setReceivingSupervisor(actor, id, orNull(f, 'supervisorId')));
  redirect(`/departures/${id}`);
}

export async function withdraw(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  await orBack(`/departures/${id}`, () => cancelDeparture(actor, id));
  redirect(`/departures/${id}`);
}

export async function execute(f: FormData) {
  const { actor } = await requireSession();
  const id = str(f, 'id');
  await orBack(`/departures/${id}`, () => executeDeparture(actor, id));
  redirect(`/departures/${id}`);
}
