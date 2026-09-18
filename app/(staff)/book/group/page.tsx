import Link from 'next/link';
import { listClients } from '../../../../src/clients/repository';
import { prisma } from '../../../../src/db';
import { requireSession } from '../../../../src/session';
import { addDays, localDateOf } from '../../../../src/time';
import { PageHeader, TierBanner } from '../../../../src/ui/primitives';
import { GroupForm } from './group-form';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

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

        <GroupForm
          clinicians={clinicians}
          clients={clients.map((c) => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, code: c.code }))}
          initial={{
            clinicianId: q.clinicianId ?? '', date, startMinute: String(15 * 60),
            type: q.type ?? 'standard', modality: q.modality ?? 'in_person', topic: '', clientIds: [],
          }}
        />
      </div>
    </>
  );
}

export default withDenial(BookGroupPage, {
  title: 'Group booking',
  children:
    'Booking a group writes to several clients’ schedules at once. Reading the log and changing the schedule are deliberately different jobs.',
});
