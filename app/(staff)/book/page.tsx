import Link from 'next/link';
import { listClients } from '../../../src/clients/repository';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { availableSlots } from '../../../src/scheduling/booking';
import { DURATION_MINUTES, type AppointmentType } from '../../../src/scheduling/recurrence';
import { addDays, localDateOf, minutesToHHMM, WEEKDAYS, weekdayOf } from '../../../src/time';
import { Badge, Card, PageHeader, SelectField, TextField, TierBanner } from '../../../src/ui/primitives';
import { book } from './actions';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

async function BookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { actor } = await requireSession();
  const q = await searchParams;

  const [clients, clinicians] = await Promise.all([
    listClients(actor),
    prisma.user.findMany({
      where: { active: true, role: { in: ['therapist', 'associate', 'supervisor'] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const clientId = q.clientId ?? clients[0]?.id ?? '';
  const chosenClient = clients.find((c) => c.id === clientId);
  const clinicianId = q.clinicianId ?? chosenClient?.treatingClinician.id ?? clinicians[0]?.id ?? '';
  const date = q.date ?? addDays(localDateOf(systemClock.now()), 1);
  const type = (q.type ?? 'standard') as AppointmentType;
  const modality = (q.modality ?? 'in_person') as 'in_person' | 'telehealth';

  const slots = clinicianId
    ? await availableSlots({ clinicianId, date, type, modality })
    : [];

  const skipped = q.skipped ? q.skipped.split(',').filter(Boolean) : [];

  return (
    <>
      <PageHeader
        title="Book a session"
        subtitle="One-off, or the standing weekly slot that runs the practice"
      />
      <div className="mb-4"><TierBanner tier="operational" /></div>

      {q.error && (
        <p className="mb-4 rounded-[var(--radius)] border px-3 py-2 text-body" style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}>
          {q.error}
        </p>
      )}

      {q.booked && (
        <div className="mb-4 rounded-[var(--radius-lg)] border px-4 py-3" style={{ borderColor: 'var(--success)', background: 'var(--success-soft)' }}>
          <p className="font-semibold">Standing session booked — {q.booked} weeks scheduled.</p>
          {skipped.length > 0 && (
            <p className="mt-1 text-body">
              {skipped.length} week{skipped.length === 1 ? '' : 's'} could not be honoured
              ({skipped.join(', ')}) — no room was free at that hour. These need a person:
              offer the client a different slot for those weeks.
            </p>
          )}
          <p className="mt-1 text-body">
            <Link className="underline" href={`/calendar?date=${date}`}>Open the calendar</Link>
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* Choosing narrows the slots; a GET keeps the whole thing linkable and
            back-button-safe, which matters when front desk is mid-conversation
            with someone standing in front of them. */}
        <Card>
          <form className="space-y-3">
            <SelectField name="clientId" label="Client" defaultValue={clientId}
              options={clients.map((c) => ({ value: c.id, label: `${c.lastName}, ${c.firstName} (${c.code})` }))} />
            <SelectField name="clinicianId" label="Clinician" defaultValue={clinicianId}
              options={clinicians.map((c) => ({ value: c.id, label: c.name }))} />
            <TextField name="date" label="Date" type="date" defaultValue={date} />
            <SelectField name="type" label="Session type" defaultValue={type}
              options={(Object.keys(DURATION_MINUTES) as AppointmentType[]).map((t) => ({
                value: t, label: `${t} — ${DURATION_MINUTES[t]} min`,
              }))} />
            <SelectField name="modality" label="Modality" defaultValue={modality}
              options={[
                { value: 'in_person', label: 'In person — needs a room' },
                { value: 'telehealth', label: 'Telehealth — no room needed' },
              ]} />
            <button className="w-full rounded-[var(--radius)] px-3 py-2 text-body font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
              Show times
            </button>
          </form>
        </Card>

        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
              {WEEKDAYS[weekdayOf(date)]} {date}
            </h2>
            {modality === 'telehealth'
              ? <Badge tone="accent" glyph="⌾">No room required</Badge>
              : <Badge glyph="⌂">A room is reserved with the clinician</Badge>}
          </div>

          {slots.length === 0 ? (
            <p className="text-body text-muted">
              Nothing free that day. {modality === 'in_person'
                ? 'Every room may be taken at this clinician’s open hours — a telehealth session would not need one.'
                : 'This clinician is not working, or is fully booked.'}
            </p>
          ) : (
            <form action={book}>
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="clinicianId" value={clinicianId} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="type" value={type} />
              <input type="hidden" name="modality" value={modality} />

              <fieldset>
                <legend className="mb-2 text-caption font-medium tracking-wide text-subtle uppercase">
                  Start time
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {slots.map((m, i) => (
                    <label
                      key={m}
                      className="cursor-pointer rounded-[var(--radius)] border px-2.5 py-1.5 font-mono text-body has-checked:border-[var(--accent)] has-checked:bg-[var(--accent-soft)]"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <input type="radio" name="startMinute" value={m} defaultChecked={i === 0} className="sr-only" />
                      {minutesToHHMM(m)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="mt-5">
                <legend className="mb-2 text-caption font-medium tracking-wide text-subtle uppercase">
                  Repeats
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    ['once', 'Just this once'],
                    ['weekly', `Every ${WEEKDAYS[weekdayOf(date)]}`],
                    ['biweekly', `Every other ${WEEKDAYS[weekdayOf(date)]}`],
                  ].map(([value, label], i) => (
                    <label
                      key={value}
                      className="cursor-pointer rounded-[var(--radius)] border px-3 py-1.5 text-body has-checked:border-[var(--accent)] has-checked:bg-[var(--accent-soft)]"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <input type="radio" name="recurrence" value={value} defaultChecked={i === 0} className="sr-only" />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-caption text-subtle">
                  A standing session books out to the practice horizon straight away. Moving
                  one week later detaches that week and leaves the rest of the series alone.
                </p>
              </fieldset>

              <button className="mt-5 rounded-[var(--radius)] px-4 py-2 text-body font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
                Book
              </button>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}

export default withDenial(BookPage, {
  title: 'Booking',
  children:
    'Making an appointment writes to the schedule. Reading the log and changing the schedule are deliberately different jobs.',
});
