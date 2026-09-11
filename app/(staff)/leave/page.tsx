import Link from 'next/link';
import { may } from '@/src/auth/guard';
import { requiresCoSignature } from '@/src/auth/permissions';
import { clinicianCapacity } from '@/src/clients/inquiry';
import { systemClock } from '@/src/clock';
import { requireSession } from '@/src/session';
import { mayTreat } from '@/src/staff/departure';
import { listLeaves } from '@/src/staff/leave-plan';
import { localDateOf } from '@/src/time';
import { Badge, Button, Card, EmptyState, PageHeader, TierBanner } from '@/src/ui/primitives';
import { withDenial } from '@/src/ui/denied';
import { DateInput, LEAVE_REFUSAL, PHASE_TONE, Pick, Refusal, dayLabel, plural } from '../departures/ui';
import { recordLeave } from './actions';

export const dynamic = 'force-dynamic';

async function LeavePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { actor } = await requireSession();
  const { error } = await searchParams;
  const leaves = await listLeaves(actor);
  const canRecord = may({ actor, action: 'create', resource: 'leave' });
  const clinicians = canRecord ? await clinicianCapacity(actor) : [];
  const today = localDateOf(systemClock.now());

  return (
    <>
      <PageHeader title="Leave" subtitle="Who is away, until when, and who covers while they are" />
      <div className="mb-4"><TierBanner tier="operational" /></div>
      <Refusal code={error} messages={LEAVE_REFUSAL} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          {leaves.length === 0 ? (
            <EmptyState title="Nobody is away">A leave recorded here tells front desk who covers, and closes the books for its days.</EmptyState>
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {leaves.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                    <span>
                      <Link href={`/leave/${l.id}`} className="font-medium text-accent hover:underline">{l.user.name}</Link>
                      <span className="ml-2 text-muted">
                        {dayLabel(l.fromDate)} to {dayLabel(l.toDate)} · covering: {l.coveringClinician.name}
                        {l._count.coverage > 0 && ` · ${plural(l._count.coverage, 'client')} with somebody else — the record says who`}
                      </span>
                    </span>
                    <Badge tone={PHASE_TONE[l.phase]}>{l.phase === 'active' ? 'away now' : l.phase}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {canRecord && (
          <Card>
            <h2 className="mb-1 font-semibold">Record a leave</h2>
            <p className="mb-3 text-caption text-subtle">
              Nothing about their caseload moves. From the first day, the person covering can
              open these clients&rsquo; records and is sent their alerts, and the day after the
              last both stop by themselves. Their books are closed in between. No reason is
              asked for, and none is kept.
            </p>
            <form action={recordLeave} className="space-y-3">
              {/* Not `userId` as the id: the dev switcher in the sidebar already owns it. */}
              <Pick id="away" name="userId" label="Who is away" options={clinicians.map((c) => ({ value: c.id, label: c.name }))} />
              <DateInput name="fromDate" label="First day away" min={today} />
              <DateInput name="toDate" label="Last day away" min={today} />
              <Pick name="coveringClinicianId" label="Who covers"
                options={clinicians.filter((c) => mayTreat(c) && !requiresCoSignature(c.role)).map((c) => ({ value: c.id, label: c.name }))} />
              <Button>Record leave</Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}

export default withDenial(LeavePage, {
  title: 'Leave',
  children:
    'Who is away and who covers is for the practice manager, supervisors and front desk. A clinician reads their own leave from its page.',
});
