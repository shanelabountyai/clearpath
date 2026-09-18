import Link from 'next/link';
import { may } from '@/src/auth/guard';
import { requiresCoSignature } from '@/src/auth/permissions';
import { clinicianCapacity } from '@/src/clients/inquiry';
import { systemClock } from '@/src/clock';
import { requireSession } from '@/src/session';
import { maySupervise, mayTreat } from '@/src/staff/departure';
import { listLeaves } from '@/src/staff/leave-plan';
import { localDateOf } from '@/src/time';
import { Badge, Card, EmptyState, PageHeader, SelectField, TextField, TierBanner } from '@/src/ui/primitives';
import { withDenial } from '@/src/ui/denied';
import { LEAVE_REFUSAL, PHASE_TONE, Refusal, dayLabel, plural } from '../departures/ui';
import { recordLeave } from './actions';
import { ConfirmButton } from '@/src/ui/confirm-button';

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
              <SelectField id="away" name="userId" label="Who is away" placeholder="Choose a clinician…" options={clinicians.map((c) => ({ value: c.id, label: c.name }))} />
              <TextField name="fromDate" label="First day away" type="date" required min={today} />
              <TextField name="toDate" label="Last day away" type="date" required min={today} />
              <SelectField name="coveringClinicianId" label="Who covers" placeholder="Choose a clinician…"
                options={clinicians.filter((c) => mayTreat(c) && !requiresCoSignature(c.role)).map((c) => ({ value: c.id, label: c.name }))} />
              {/* P1-3: required when the person away supervises anybody; the door says so if it is missed. */}
              <SelectField name="coveringSupervisorId" label="Supervision cover"
                options={[
                  { value: '', label: 'Nobody — they supervise nobody' },
                  ...clinicians.filter(maySupervise).map((c) => ({ value: c.id, label: c.name })),
                ]} />
              <ConfirmButton
                title="Record this leave?"
                subject={{ field: 'userId', label: 'Who is away' }}
                consequence="Their books close for the dates given. From the first day, the person covering can open their clients' records and is sent their alerts."
                confirmLabel="Record leave"
              >
                Record leave
              </ConfirmButton>
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
