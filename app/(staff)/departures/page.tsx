import Link from 'next/link';
import { may } from '@/src/auth/guard';
import { clinicianCapacity } from '@/src/clients/inquiry';
import { systemClock } from '@/src/clock';
import { requireSession } from '@/src/session';
import { listDepartures, maySupervise } from '@/src/staff/departure';
import { localDateOf } from '@/src/time';
import { Badge, Button, Card, EmptyState, PageHeader, TierBanner } from '@/src/ui/primitives';
import { withDenial } from '@/src/ui/denied';
import { recordNotice } from './actions';
import { DateInput, Pick, Refusal, STATUS_TONE, dayLabel } from './ui';

export const dynamic = 'force-dynamic';

async function DeparturesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { actor } = await requireSession();
  const { error } = await searchParams;
  const departures = await listDepartures(actor);
  const canPlan = may({ actor, action: 'create', resource: 'departure' });
  const clinicians = canPlan ? await clinicianCapacity(actor) : [];

  return (
    <>
      <PageHeader title="Departures" subtitle="A clinician leaving is a plan before it is an event" />
      <div className="mb-4"><TierBanner tier="operational" /></div>
      <Refusal code={error} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          {departures.length === 0 ? (
            <EmptyState title="Nobody is leaving">A notice recorded here appears as a plan to work through.</EmptyState>
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {departures.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                    <span>
                      <Link href={`/departures/${d.id}`} className="font-medium text-accent hover:underline">
                        {d.user.name}
                      </Link>
                      <span className="ml-2 text-muted">
                        last day {dayLabel(d.lastDayOn)} · notice {localDateOf(d.noticeAt)}
                      </span>
                    </span>
                    <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {canPlan && (
          <Card>
            <h2 className="mb-1 font-semibold">Record a notice</h2>
            <p className="mb-3 text-caption text-subtle">
              This closes their books straight away, so nobody new is offered to them, and
              changes nothing else. They keep working, signing and seeing their clients
              until the last day. Nothing moves until somebody executes the plan.
            </p>
            <form action={recordNotice} className="space-y-3">
              {/* Not `userId` as the id: the dev switcher in the sidebar already owns it, and
                  a duplicate id points this label at the wrong select. */}
              <Pick id="leaver" name="userId" label="Who is leaving" options={clinicians.map((c) => ({ value: c.id, label: c.name }))} />
              <DateInput name="lastDayOn" label="Last day" min={localDateOf(systemClock.now())} />
              <Pick name="receivingSupervisorId" label="Their associates go to"
                options={[
                  { value: '', label: 'Nobody — they supervise nobody' },
                  ...clinicians.filter((c) => maySupervise(c)).map((c) => ({ value: c.id, label: c.name })),
                ]} />
              <Button>Record notice</Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}

export default withDenial(DeparturesPage, {
  title: 'Departures',
  children:
    'Who is leaving, and what happens to their clients, is for the practice manager, supervisors and front desk. A clinician who is leaving sees their own departure from the notice on their screen.',
});
