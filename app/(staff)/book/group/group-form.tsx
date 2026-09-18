'use client';

import { useActionState } from 'react';
import { minutesToHHMM } from '../../../../src/time';
import { Badge, Button, Card } from '../../../../src/ui/primitives';
import { bookGroup, type GroupFormValues } from '../../groups/actions';

/** Half-hour starts across the working day. The database arbitrates the rest. */
const STARTS = Array.from({ length: 20 }, (_, i) => 8 * 60 + i * 30);

/**
 * The group booking form that survives a conflict (PRD 4, Q3; ticket F2). A
 * refusal returns what was entered and every field refills from it, the ticked
 * attendees included, so front desk changes the one thing that clashed.
 */
export function GroupForm({
  clinicians,
  clients,
  initial,
}: {
  clinicians: { id: string; name: string }[];
  clients: { id: string; firstName: string; lastName: string; code: string }[];
  initial: GroupFormValues;
}) {
  const [state, dispatch, pending] = useActionState(bookGroup, null);
  const v = state?.values ?? initial;
  const field = 'mt-1 w-full rounded-[var(--radius)] border px-2 py-1 text-body';
  const style = { borderColor: 'var(--border)', background: 'var(--surface-raised)' };

  return (
    <>
      {state && (
        <Card key={state.id}><p role="alert"><Badge tone="danger">{state.error}</Badge></p></Card>
      )}

      <Card>
        <form key={state?.id} action={dispatch} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
              Clinician
              <select name="clinicianId" defaultValue={v.clinicianId} className={field} style={style}>
                {clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>

            <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
              Date
              <input type="date" name="date" defaultValue={v.date} className={field} style={style} />
            </label>

            <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
              Start
              <select name="startMinute" defaultValue={v.startMinute} className={field} style={style}>
                {STARTS.map((m) => <option key={m} value={m}>{minutesToHHMM(m)}</option>)}
              </select>
            </label>

            <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
              Length
              <select name="type" defaultValue={v.type} className={field} style={style}>
                <option value="standard">Standard (50 min)</option>
                <option value="extended">Extended (80 min)</option>
                <option value="intake">Intake (75 min)</option>
              </select>
            </label>

            <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
              Modality
              <select name="modality" defaultValue={v.modality} className={field} style={style}>
                <option value="in_person">In person</option>
                <option value="telehealth">Telehealth</option>
              </select>
            </label>

            <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
              Topic (appears on the calendar)
              <input
                name="topic" placeholder="Tuesday skills group" defaultValue={v.topic}
                className={field} style={style}
              />
            </label>
          </div>

          <fieldset className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <legend className="text-micro font-medium uppercase tracking-wide text-subtle">
              Attendees
            </legend>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {clients.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-body">
                  <input type="checkbox" name="clientIds" value={c.id} defaultChecked={v.clientIds.includes(c.id)} />
                  <span>{c.firstName} {c.lastName}</span>
                  <span className="font-mono text-caption text-subtle">{c.code}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <Button variant="solid" disabled={pending}>Book the group</Button>
        </form>
      </Card>
    </>
  );
}
