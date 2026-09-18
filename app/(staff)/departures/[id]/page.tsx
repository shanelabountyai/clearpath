import Link from 'next/link';
import { may } from '@/src/auth/guard';
import { clinicianCapacity, listReferrers } from '@/src/clients/inquiry';
import { requireSession } from '@/src/session';
import { getDeparturePlan, maySupervise, ownDrafts, type DepartureBlocker } from '@/src/staff/departure';
import { localDateOf, minutesToHHMM, utcToZoned, WEEKDAYS } from '@/src/time';
import { Badge, Button, Card, EmptyState, Field, PageHeader, SelectField, TierBanner } from '@/src/ui/primitives';
import { withDenial } from '@/src/ui/denied';
import { chooseSupervisor, decide, execute, withdraw } from '../actions';
import { Refusal, STATUS_TONE, dayLabel, plural } from '../ui';
import { ConfirmButton } from '@/src/ui/confirm-button';

export const dynamic = 'force-dynamic';

const DISPOSITIONS = [
  { value: 'transfer', label: 'Transfer to a colleague' },
  { value: 'discharge', label: 'Discharge' },
  { value: 'referred_out', label: 'Refer out' },
];

function when(at: Date) {
  const z = utcToZoned(at);
  return `${WEEKDAYS[z.weekday]} ${z.date} ${minutesToHHMM(z.minutes)}`;
}

function decisionLabel(a: {
  disposition: string; receivingClinician: { name: string } | null; referredOutTo: { practice: string } | null;
}) {
  if (a.disposition === 'transfer') return `To ${a.receivingClinician?.name ?? 'nobody'}`;
  if (a.disposition === 'referred_out') return a.referredOutTo ? `Referred to ${a.referredOutTo.practice}` : 'Referred out';
  return 'Discharge';
}

async function DeparturePlanPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const { actor } = await requireSession();

  const plan = await getDeparturePlan(actor, id);
  const subject = { subjectUserId: plan.userId };
  const planned = plan.status === 'planned';
  const canDecide = planned && may({ actor, action: 'update', resource: 'departure', target: subject });
  const canExecute = planned && may({ actor, action: 'depart', resource: 'departure', target: subject });

  const clinicians = canDecide ? await clinicianCapacity(actor) : [];
  const referrers = canDecide ? await listReferrers(actor, { activeOnly: true }) : [];
  const own = actor.id === plan.userId ? await ownDrafts(actor) : null;

  const receivers = clinicians.filter((c) => c.id !== plan.userId);
  const byId = new Map(plan.clients.map((c) => [c.id, c]));
  const of = <K extends DepartureBlocker['kind']>(kind: K) =>
    plan.blockers.filter((b): b is Extract<DepartureBlocker, { kind: K }> => b.kind === kind);
  const undecided = new Set(of('undecided').map((b) => b.clientId));
  const unavailable = new Set(of('receiver_unavailable').map((b) => b.clientId));
  const clashes = of('hour_clash');
  const unreadAlerts = of('unread_alert').length;
  const orphans = of('supervisee_unassigned').length;
  const openLeaves = of('leave_open').length;

  return (
    <>
      <PageHeader
        title={`${plan.user.name} is leaving`}
        subtitle={<>Last day {dayLabel(plan.lastDayOn)} · notice recorded {localDateOf(plan.noticeAt)} by {plan.plannedBy.name}</>}
        actions={<Badge tone={STATUS_TONE[plan.status]}>{plan.status}</Badge>}
      />
      <div className="mb-4"><TierBanner tier="operational" /></div>
      <Refusal code={error} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          {own && (
            <Card>
              <h2 className="font-semibold">Your unsigned notes</h2>
              <p className="mt-1 mb-3 max-w-prose text-body text-muted">
                {own.daysLeft > 0 ? `${plural(own.daysLeft, 'day')} left.` : 'Today is your last day.'}{' '}
                A note still unsigned when you leave cannot be signed by anybody, not your
                successor and not your supervisor. It is kept and marked abandoned, and that
                session has no signed note for good.
              </p>
              {own.drafts.length === 0 ? (
                <EmptyState title="Everything is signed">Nothing of yours will be left behind.</EmptyState>
              ) : (
                <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {own.drafts.map((n) => (
                    <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-body">
                      <Link href={`/notes/${n.id}`} className="font-medium text-accent hover:underline">
                        {n.client.lastName}, {n.client.firstName}
                      </Link>
                      <span className="text-muted">
                        {n.appointment ? `session ${when(n.appointment.startAt)}` : `started ${localDateOf(n.createdAt)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <Card className="p-0">
            <div className="px-4 pt-4 pb-3">
              <h2 className="font-semibold">Caseload</h2>
              <p className="mt-1 max-w-prose text-caption text-subtle">
                Every client needs a decision, and there is no default. &ldquo;Everything
                unassigned goes to the supervisor&rdquo; is how a whole caseload ends up with a
                new therapist because nobody read a screen.
              </p>
            </div>
            {plan.clients.length === 0 ? (
              <div className="px-4 pb-4"><EmptyState title="No active clients">There is nothing here to decide.</EmptyState></div>
            ) : (
              <ul className="divide-y border-t" style={{ borderColor: 'var(--border)' }}>
                {plan.clients.map((c) => {
                  const a = c.assignment;
                  return (
                    <li key={c.id} className="space-y-2 px-4 py-3 text-body">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <span className="font-medium">{c.lastName}, {c.firstName}</span>{' '}
                          <span className="font-mono text-caption text-subtle">{c.code}</span>
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {undecided.has(c.id) && <Badge tone="warning" glyph="!">No decision</Badge>}
                          {a && <Badge tone="accent">{decisionLabel(a)}</Badge>}
                          {unavailable.has(c.id) && <Badge tone="danger" glyph="!">Receiver cannot take this</Badge>}
                        </span>
                      </div>
                      {a && (
                        <p className="text-caption text-subtle">Decided by {a.decidedBy.name}, {localDateOf(a.decidedAt)}</p>
                      )}
                      {canDecide && (
                        <form action={decide} className="grid gap-2 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end">
                          <input type="hidden" name="id" value={plan.id} />
                          <input type="hidden" name="clientId" value={c.id} />
                          <SelectField id={`disposition-${c.id}`} name="disposition" label="Decision"
                            defaultValue={a?.disposition ?? 'transfer'} options={DISPOSITIONS} />
                          <SelectField id={`receiver-${c.id}`} name="receivingClinicianId" label="Receiving clinician"
                            defaultValue={a?.receivingClinicianId ?? ''}
                            options={[{ value: '', label: '—' }, ...receivers.map((r) => ({
                              value: r.id, label: `${r.name} · ${plural(r.caseload, 'client')}${r.accepting ? '' : ' · closed'}`,
                            }))]} />
                          <SelectField id={`referrer-${c.id}`} name="referredOutToId" label="Referred to"
                            defaultValue={a?.referredOutToId ?? ''}
                            options={[{ value: '', label: '—' }, ...referrers.map((r) => ({ value: r.id, label: r.practice }))]} />
                          <Button variant="quiet">{a ? 'Change' : 'Decide'}</Button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            {plan.status === 'executed' && (
              <>
                <h2 className="mb-2 font-semibold">Executed</h2>
                <p className="text-body text-muted">
                  The caseload moved{plan.executedAt ? ` on ${localDateOf(plan.executedAt)}` : ''}, in one
                  transaction. Unsigned notes were marked abandoned, private notes became
                  unreachable, and the account closed.
                </p>
              </>
            )}
            {plan.status === 'cancelled' && (
              <>
                <h2 className="mb-2 font-semibold">Withdrawn</h2>
                <p className="text-body text-muted">
                  Notice was withdrawn. Their books went back to what they were at notice, and
                  nothing else had happened that needed undoing.
                </p>
              </>
            )}
            {planned && (
              <>
                <h2 className="mb-2 font-semibold">Is this ready?</h2>
                {plan.blockers.length === 0 ? (
                  <Badge tone="success" glyph="✓">Nothing in the way</Badge>
                ) : (
                  <ul className="space-y-2 text-body">
                    {undecided.size > 0 && <li>{plural(undecided.size, 'client')} with no decision.</li>}
                    {unavailable.size > 0 && <li>{plural(unavailable.size, 'transfer')} to somebody who cannot take it.</li>}
                    {clashes.map((b) => (
                      <li key={b.appointmentId}>
                        <span className="font-medium">{when(b.startAt)}</span>:{' '}
                        {byId.get(b.clientId)?.lastName}&rsquo;s session lands on an hour{' '}
                        {byId.get(b.clientId)?.assignment?.receivingClinician?.name ?? 'the receiver'} already
                        holds.{' '}
                        <Link href={`/appointments/${b.appointmentId}`} className="text-accent hover:underline">Move it</Link>
                      </li>
                    ))}
                    {unreadAlerts > 0 && (
                      // The client is deliberately not named. An alert is for the
                      // clinician it was sent to, and this list is read by front desk.
                      <li>
                        {plural(unreadAlerts, 'unread alert')} for {plan.user.name}, on clients nobody is
                        receiving, and no supervisor to pass them to. {plan.user.name} needs to read
                        them before leaving.
                      </li>
                    )}
                    {orphans > 0 && (
                      <li>{plural(orphans, 'associate')} supervised by {plan.user.name}, and nobody named to take them.</li>
                    )}
                    {openLeaves > 0 && (
                      <li>{plan.user.name} has a leave that has not ended. End it early or cancel it first.</li>
                    )}
                  </ul>
                )}
              </>
            )}

            {plan.receivingSupervisor && !canDecide && (
              <dl className="mt-3"><Field label="Associates go to">{plan.receivingSupervisor.name}</Field></dl>
            )}
            {canDecide && (orphans > 0 || plan.receivingSupervisor) && (
              <form action={chooseSupervisor} className="mt-4 space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <input type="hidden" name="id" value={plan.id} />
                <SelectField name="supervisorId" label="Their associates go to" defaultValue={plan.receivingSupervisor?.id ?? ''}
                  options={[
                    { value: '', label: 'Nobody named' },
                    ...receivers.filter((r) => maySupervise(r)).map((r) => ({ value: r.id, label: r.name })),
                  ]} />
                <Button variant="quiet">Save</Button>
              </form>
            )}

            {canExecute && (
              <form action={execute} className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <input type="hidden" name="id" value={plan.id} />
                <p className="mb-2 text-caption text-subtle">
                  One transaction. Every decision here takes effect, unsigned notes are
                  marked abandoned, private notes become unreachable, and the account closes.
                  If a single moved session lands on an hour its new clinician already holds,
                  none of it happens.
                </p>
                <ConfirmButton
                  variant="danger"
                  title="Execute this departure?"
                  consequence="Every decision in this plan takes effect in one transaction. Unsigned notes are marked abandoned, private notes become unreachable, and the account closes. None of this can be undone."
                  confirmLabel="Execute departure"
                >
                  Execute departure
                </ConfirmButton>
              </form>
            )}
            {canDecide && (
              <form action={withdraw} className="mt-3">
                <input type="hidden" name="id" value={plan.id} />
                <Button variant="quiet">Withdraw notice</Button>
              </form>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

export default withDenial(DeparturePlanPage, {
  title: 'Departure',
  children:
    'A colleague’s departure, and where their clients go, is for the practice manager, supervisors and front desk. Your own departure is yours to read.',
});
