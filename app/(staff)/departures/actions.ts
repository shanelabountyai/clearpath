'use server';

import { redirect } from 'next/navigation';
import { Conflict } from '@/src/errors';
import { requireSession } from '@/src/session';
import {
  cancelDeparture, decideAssignment, executeDeparture, planDeparture, setReceivingSupervisor,
  type Disposition,
} from '@/src/staff/departure';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const orNull = (f: FormData, k: string) => str(f, k) || null;

/**
 * Run one act, or come back to `path` saying why not.
 *
 * Only a `Conflict`'s code travels: it is the whole vocabulary the page renders.
 * A denial is not caught — every control on these pages is drawn from the
 * matrix that would refuse it, so a `Forbidden` here is a hand-rolled POST, and
 * it is on the record either way.
 */
async function orBack<T>(path: string, act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (e) {
    if (e instanceof Conflict) redirect(`${path}?error=${e.code ?? 'conflict'}`);
    throw e;
  }
}

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
