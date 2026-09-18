import Link from 'next/link';
import { listClients } from '../../../../src/clients/repository';
import { prisma } from '../../../../src/db';
import { requireSession } from '../../../../src/session';
import { addDays, localDateOf, minutesToHHMM } from '../../../../src/time';
import { Badge, Card, PageHeader, TierBanner } from '../../../../src/ui/primitives';
import { bookGroup } from '../../groups/actions';
import { Button } from '@/src/ui/primitives';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

/** Half-hour starts across the working day. The database arbitrates the rest. */
const STARTS = Array.from({ length: 20 }, (_, i) => 8 * 60 + i * 30);

async function BookGroupPage({
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

  const date = q.date ?? addDays(localDateOf(systemClock.now()), 1);
  const field = 'mt-1 w-full rounded-[var(--radius)] border px-2 py-1 text-body';
  const style = { borderColor: 'var(--border)', background: 'var(--surface-raised)' };

  return (
    <>
      <PageHeader
        title="Book a group session"
        subtitle={<Link href="/book" className="text-accent hover:underline">one client instead</Link>}
      />

      <div className="mx-auto max-w-2xl space-y-4">
        <TierBanner tier="operational">
          One hour, one clinician, one room, several clients. Each attendee gets
          their own appointment underneath — their own note, fee and attendance —
          so a group is a shared hour and never a shared record.
        </TierBanner>

        {q.error && (
          <Card><Badge tone="danger">{q.error}</Badge></Card>
        )}

        <Card>
          <form action={bookGroup} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
                Clinician
                <select name="clinicianId" defaultValue={q.clinicianId} className={field} style={style}>
                  {clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>

              <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
                Date
                <input type="date" name="date" defaultValue={date} className={field} style={style} />
              </label>

              <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
                Start
                <select name="startMinute" defaultValue={15 * 60} className={field} style={style}>
                  {STARTS.map((m) => <option key={m} value={m}>{minutesToHHMM(m)}</option>)}
                </select>
              </label>

              <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
                Length
                <select name="type" defaultValue={q.type ?? 'standard'} className={field} style={style}>
                  <option value="standard">Standard (50 min)</option>
                  <option value="extended">Extended (80 min)</option>
                  <option value="intake">Intake (75 min)</option>
                </select>
              </label>

              <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
                Modality
                <select name="modality" defaultValue={q.modality ?? 'in_person'} className={field} style={style}>
                  <option value="in_person">In person</option>
                  <option value="telehealth">Telehealth</option>
                </select>
              </label>

              <label className="block text-micro font-medium uppercase tracking-wide text-subtle">
                Topic (appears on the calendar)
                <input
                  name="topic" placeholder="Tuesday skills group"
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
                    <input type="checkbox" name="clientIds" value={c.id} />
                    <span>{c.firstName} {c.lastName}</span>
                    <span className="font-mono text-caption text-subtle">{c.code}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <Button variant="solid">Book the group</Button>
          </form>
        </Card>
      </div>
    </>
  );
}

export default withDenial(BookGroupPage, {
  title: 'Group booking',
  children:
    'Booking a group writes to several clients’ schedules at once. Reading the log and changing the schedule are deliberately different jobs.',
});
