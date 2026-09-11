import { may } from '@/src/auth/guard';
import { requireSession } from '@/src/session';
import { getLeavePlan } from '@/src/staff/leave-plan';
import { localDateOf } from '@/src/time';
import { Badge, Button, Card, EmptyState, Field, PageHeader, TierBanner } from '@/src/ui/primitives';
import { withDenial } from '@/src/ui/denied';
import { backToday, cancel, chooseCoverer, chooseSupervisionCover, decideClient, moveDates } from '../actions';
import { DateInput, LEAVE_REFUSAL, PHASE_TONE, Pick, Refusal, dayLabel, plural } from '../../departures/ui';

export const dynamic = 'force-dynamic';

async function LeavePlanPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const { actor } = await requireSession();

  const plan = await getLeavePlan(actor, id);
  const live = plan.phase === 'upcoming' || plan.phase === 'active';
  const canUpdate = live && may({ actor, action: 'update', resource: 'leave', target: { subjectUserId: plan.userId } });

  const leaveCoverer = plan.coveringClinician;
  const cannot = new Set(plan.unavailable);
  const splitsBlocked = plan.clients.filter((c) => c.coverage && cannot.has(c.coverage.coveringClinicianId)).length;
  // The pickers offer who could cover the rest, and keep whoever is named now
  // selectable, so a blocked choice shows as itself rather than as the first name.
  const choices = (current: { id: string; name: string }) => [
    ...(plan.coverers.some((c) => c.id === current.id) ? [] : [{ value: current.id, label: `${current.name} — cannot cover` }]),
    ...plan.coverers.map((c) => ({ value: c.id, label: c.name })),
  ];
  const supervisionCover = plan.coveringSupervisor;
  const supervisionChoices = [
    { value: '', label: 'Nobody' },
    ...(supervisionCover && !plan.supervisors.some((u) => u.id === supervisionCover.id)
      ? [{ value: supervisionCover.id, label: `${supervisionCover.name} — cannot cover` }] : []),
    ...plan.supervisors.map((u) => ({ value: u.id, label: u.name })),
  ];

  return (
    <>
      <PageHeader
        title={`${plan.user.name} — leave`}
        subtitle={<>{dayLabel(plan.fromDate)} to {dayLabel(plan.toDate)} · recorded by {plan.plannedBy.name}</>}
        actions={<Badge tone={PHASE_TONE[plan.phase]}>{plan.phase === 'active' ? 'away now' : plan.phase}</Badge>}
      />
      <div className="mb-4"><TierBanner tier="operational" /></div>
      <Refusal code={error} messages={LEAVE_REFUSAL} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="p-0">
          <div className="px-4 pt-4 pb-3">
            <h2 className="font-semibold">Who covers each client</h2>
            <p className="mt-1 max-w-prose text-caption text-subtle">
              Every client is covered by {leaveCoverer.name} unless somebody decides otherwise
              here. The treating clinician does not change, and nothing has to be undone on
              the way back.
            </p>
          </div>
          {plan.clients.length === 0 ? (
            <div className="px-4 pb-4"><EmptyState title="No active clients">There is nobody here to cover.</EmptyState></div>
          ) : (
            <ul className="divide-y border-t" style={{ borderColor: 'var(--border)' }}>
              {plan.clients.map((c) => {
                const k = c.coverage;
                const who = k ? { id: k.coveringClinicianId, name: k.coveringClinician.name } : leaveCoverer;
                return (
                  <li key={c.id} className="space-y-2 px-4 py-3 text-body">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="font-medium">{c.lastName}, {c.firstName}</span>{' '}
                        <span className="font-mono text-caption text-subtle">{c.code}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={k ? 'accent' : 'neutral'}>{k ? `Covered by ${who.name}` : `With ${who.name}, as the leave`}</Badge>
                        {live && k && cannot.has(k.coveringClinicianId) && <Badge tone="danger" glyph="!">Cannot cover the rest</Badge>}
                      </span>
                    </div>
                    {k && <p className="text-caption text-subtle">Decided by {k.decidedBy.name}, {localDateOf(k.decidedAt)}</p>}
                    {canUpdate && (
                      <form action={decideClient} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <input type="hidden" name="id" value={plan.id} />
                        <input type="hidden" name="clientId" value={c.id} />
                        <Pick id={`coverer-${c.id}`} name="coveringClinicianId" label="Covered by" defaultValue={who.id}
                          options={[
                            { value: leaveCoverer.id, label: `${leaveCoverer.name}, as the leave` },
                            ...choices(who).filter((o) => o.value !== leaveCoverer.id),
                          ]} />
                        <Button variant="quiet">Save</Button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            {plan.phase === 'ended' && (
              <>
                <h2 className="mb-2 font-semibold">Ended</h2>
                <p className="text-body text-muted">
                  The last day was {dayLabel(plan.toDate)}. Nothing had to run for the covering
                  access to stop, and this plan no longer changes: it is the record of who could
                  read what, and on which days.
                </p>
              </>
            )}
            {plan.phase === 'cancelled' && (
              <>
                <h2 className="mb-2 font-semibold">Cancelled</h2>
                <p className="text-body text-muted">This leave never started, and its days went back on the calendar.</p>
              </>
            )}
            {live && (
              <>
                <h2 className="mb-2 font-semibold">Is everyone covered?</h2>
                {plan.unavailable.length === 0 ? (
                  <Badge tone="success" glyph="✓">Everybody covering is here for the rest of it</Badge>
                ) : (
                  // Why is not said. A colleague's own leave or notice is theirs, and
                  // this screen is read by the person away. The fix is the same either way.
                  <ul className="space-y-2 text-body">
                    {cannot.has(leaveCoverer.id) && (
                      <li>{leaveCoverer.name} cannot cover the rest of this leave. Name somebody else.</li>
                    )}
                    {splitsBlocked > 0 && (
                      <li>{plural(splitsBlocked, 'client')} covered by somebody who cannot cover the rest of it.</li>
                    )}
                  </ul>
                )}
              </>
            )}

            {canUpdate ? (
              <form action={chooseCoverer} className="mt-4 space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <input type="hidden" name="id" value={plan.id} />
                <Pick name="coveringClinicianId" label="Covering the leave" defaultValue={leaveCoverer.id} options={choices(leaveCoverer)} />
                <Button variant="quiet">Name coverer</Button>
              </form>
            ) : (
              <dl className="mt-3"><Field label="Covering the leave">{leaveCoverer.name}</Field></dl>
            )}
          </Card>

          {(plan.supervisees > 0 || supervisionCover) && (
            <Card>
              <h2 className="mb-1 font-semibold">Supervision</h2>
              <p className="mb-3 text-caption text-subtle">
                {plan.user.name} has {plural(plan.supervisees, 'supervisee')}. Whoever covers
                countersigns their notes for these days and opens the records behind them, and
                nothing else. Private notes stay with whoever wrote them.
              </p>
              {plan.supervisionBlocked && (
                <Badge tone="danger" glyph="!">
                  {supervisionCover ? `${supervisionCover.name} cannot cover the rest of it` : 'Nobody countersigns while they are away'}
                </Badge>
              )}
              {canUpdate ? (
                <form action={chooseSupervisionCover} className="mt-3 space-y-2">
                  <input type="hidden" name="id" value={plan.id} />
                  <Pick name="coveringSupervisorId" label="Covering supervision" defaultValue={supervisionCover?.id ?? ''} options={supervisionChoices} />
                  <Button variant="quiet">Name supervision cover</Button>
                </form>
              ) : (
                <dl className="mt-3"><Field label="Covering supervision">{supervisionCover?.name ?? 'Nobody'}</Field></dl>
              )}
            </Card>
          )}

          {canUpdate && (
            <Card>
              <h2 className="mb-2 font-semibold">Dates</h2>
              <form action={moveDates} className="space-y-3">
                <input type="hidden" name="id" value={plan.id} />
                {plan.phase === 'active' ? (
                  <>
                    <input type="hidden" name="fromDate" value={plan.fromDate} />
                    <dl><Field label="First day away">{dayLabel(plan.fromDate)}, and it stays</Field></dl>
                  </>
                ) : (
                  <DateInput name="fromDate" label="First day away" min={plan.today} defaultValue={plan.fromDate} />
                )}
                <DateInput name="toDate" label="Last day away" min={plan.today} defaultValue={plan.toDate} />
                <Button variant="quiet">Move dates</Button>
              </form>

              {plan.phase === 'active' && plan.fromDate < plan.today && (
                <form action={backToday} className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                  <input type="hidden" name="id" value={plan.id} />
                  <input type="hidden" name="fromDate" value={plan.fromDate} />
                  <p className="mb-2 text-caption text-subtle">
                    Ends the leave now, with yesterday as its last day. Covering access stops at
                    once, and alerts nobody has read go back to {plan.user.name}.
                  </p>
                  <Button>{plan.user.name} is back today</Button>
                </form>
              )}
              {plan.phase === 'upcoming' && (
                <form action={cancel} className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                  <input type="hidden" name="id" value={plan.id} />
                  <Button variant="quiet">Cancel leave</Button>
                </form>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

export default withDenial(LeavePlanPage, {
  title: 'Leave',
  children:
    'A colleague’s leave, and who covers their clients, is for the practice manager, supervisors and front desk. Your own leave is yours to read.',
});
