import Link from 'next/link';
import { getAppointment } from '../../../../src/scheduling/calendar';
import { TRANSITIONS, classifyCancellation, type Status } from '../../../../src/scheduling/lifecycle';
import { prisma } from '../../../../src/db';
import { Forbidden } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { may } from '../../../../src/auth/guard';
import { localDateOf, minutesToHHMM, utcToZoned, WEEKDAYS } from '../../../../src/time';
import { Badge, Card, ConfirmationChip, Field, PageHeader, STATUS_META, StatusChip, money } from '../../../../src/ui/primitives';
import { BreakGlassPrompt } from '../../break-glass';
import { advanceStatus, cancelSession, moveSession, startProgressNote, waiveSessionFee } from '../actions';
import { systemClock } from '@/src/clock';
import { Button } from '@/src/ui/primitives';

export const dynamic = 'force-dynamic';

export default async function AppointmentPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const { actor } = await requireSession();

  let appt;
  try {
    appt = await getAppointment(actor, id);
  } catch (e) {
    if (e instanceof Forbidden) return <BreakGlassPrompt resource="this session" />;
    throw e;
  }

  const when = utcToZoned(appt.startAt);
  const settings = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const windowHours = settings?.lateCancelWindowHours ?? 24;
  const wouldBeLate = classifyCancellation(appt.startAt, systemClock.now(), windowHours) === 'late_cancelled';
  const next = TRANSITIONS[appt.status as Status];
  const canWriteNote = may({
    actor, action: 'create', resource: 'progress_note', target: { clinicianId: appt.clinicianId },
  });
  // The matrix decides whether the affordance is drawn, and decides again when
  // the form is submitted. Drawing it is not the permission.
  const canWaive = may({ actor, action: 'waive', resource: 'fee' });

  return (
    <>
      <PageHeader
        title={`${appt.client.firstName} ${appt.client.lastName}`}
        subtitle={
          <>
            {WEEKDAYS[when.weekday]} {when.date} at {minutesToHHMM(when.minutes)} ·{' '}
            {appt.clinician.name}
          </>
        }
        actions={<StatusChip status={appt.status} />}
      />

      {error && (
        <p className="mb-4 rounded-[var(--radius)] border px-3 py-2 text-body" style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}>
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <Field label="Client">
                <Link href={`/clients/${appt.client.id}`} className="text-accent hover:underline">
                  {appt.client.code}
                </Link>
              </Field>
              <Field label="Type">{appt.type}</Field>
              <Field label="Modality">
                {appt.modality === 'telehealth'
                  ? <Badge tone="accent" glyph="⌾">Telehealth — no room</Badge>
                  : <Badge glyph="⌂">In person</Badge>}
              </Field>
              <Field label="Room">{appt.room?.name ?? <span className="text-subtle">Not needed</span>}</Field>
              <Field label="Standing">
                {appt.series
                  ? appt.detached
                    ? <Badge tone="warning">Moved out of the series</Badge>
                    : <Badge tone="info" glyph="↻">{appt.series.frequency}, {WEEKDAYS[appt.series.weekday]}</Badge>
                  : <span className="text-subtle">One-off</span>}
              </Field>
              <Field label="Confirmation">
                {/* Beside the status, never merged into it. A client who never
                    answered and then walked in reads `Completed` + `No reply`,
                    which is the pair the whole feature exists to keep apart. */}
                <ConfirmationChip confirmation={appt.confirmation} />
              </Field>
              <Field label="Charge">
                {appt.feeWaivedAt ? (
                  <>
                    {money(0)} <Badge tone="info" glyph="↩">Waived</Badge>
                  </>
                ) : (
                  money(appt.chargeFeeCents)
                )}
              </Field>
            </dl>
          </Card>

          {next.length > 0 && (
            <Card>
              <h2 className="mb-2 font-semibold">Move this session along</h2>
              <div className="flex flex-wrap gap-2">
                {next
                  .filter((s) => s !== 'cancelled' && s !== 'late_cancelled')
                  .map((to) => (
                    <form key={to} action={advanceStatus}>
                      <input type="hidden" name="appointmentId" value={appt.id} />
                      <input type="hidden" name="to" value={to} />
                      <button
                        className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium transition-colors hover:bg-[var(--surface-inset)]"
                        style={{ borderColor: 'var(--border-strong)' }}
                      >
                        {STATUS_META[to]?.glyph} Mark {STATUS_META[to]?.label.toLowerCase()}
                      </button>
                    </form>
                  ))}
              </div>
            </Card>
          )}

          {canWaive && appt.chargeFeeCents !== null && (
            <Card>
              <h2 className="font-semibold">Waive this fee</h2>
              {appt.feeWaivedAt ? (
                /* Once, and on the record. A second waiver would put two
                   decisions in the trail where the practice made one. */
                <p className="mt-2 text-body text-subtle">
                  Waived on {localDateOf(appt.feeWaivedAt)} · {appt.feeWaiveReason?.replace('_', ' ')}
                </p>
              ) : (
                <>
                  <p className="mt-2 text-body text-subtle">
                    The charge goes to zero and what was charged stays on the record. This
                    changes nothing about whether the client attended.
                  </p>
                  <form action={waiveSessionFee} className="mt-3 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="appointmentId" value={appt.id} />
                    <div className="min-w-[220px] flex-1">
                      <label htmlFor="waive-reason" className="block text-micro font-medium tracking-wide text-subtle uppercase">
                        Reason
                      </label>
                      {/* A fixed list, not a text box: a free-text field on a
                          money decision collects, sooner or later, a sentence
                          about why the client was struggling. */}
                      <select
                        id="waive-reason" name="reason" defaultValue="practice_error"
                        className="mt-1 w-full rounded-[var(--radius)] border px-2 py-1.5 text-body"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                      >
                        <option value="practice_error">Practice error</option>
                        <option value="client_disputed">Client disputed</option>
                        <option value="emergency">Emergency</option>
                        <option value="goodwill">Goodwill</option>
                      </select>
                    </div>
                    <Button>Waive {money(appt.chargeFeeCents)}</Button>
                  </form>
                </>
              )}
            </Card>
          )}

          {(next.includes('cancelled') || next.includes('late_cancelled')) && (
            <Card>
              <h2 className="font-semibold">Cancel</h2>
              {/* The consequence is stated before the click, not discovered after
                  it. Whether it counts as late is decided by the server from the
                  clock — this is a preview of that decision, not the decision. */}
              <p
                className="mt-2 rounded-[var(--radius)] px-3 py-2 text-body"
                style={{
                  background: wouldBeLate ? 'var(--danger-soft)' : 'var(--success-soft)',
                  color: wouldBeLate ? 'var(--danger)' : 'var(--success)',
                }}
              >
                {wouldBeLate ? (
                  <>
                    <strong>This would be a late cancellation.</strong> Less than {windowHours} hours&rsquo;
                    notice, so the policy fee of {money(settings?.lateCancelFeeCents ?? 0)} applies.
                  </>
                ) : (
                  <>
                    <strong>Advance notice.</strong> More than {windowHours} hours ahead, so no fee applies.
                  </>
                )}
              </p>
              <form action={cancelSession} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="appointmentId" value={appt.id} />
                <div className="min-w-[220px] flex-1">
                  <label htmlFor="reason" className="block text-micro font-medium tracking-wide text-subtle uppercase">
                    Reason (operational only — never clinical)
                  </label>
                  <input
                    id="reason" name="reason" placeholder="e.g. client rescheduled"
                    className="mt-1 w-full rounded-[var(--radius)] border px-2 py-1.5 text-body"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                  />
                </div>
                <Button variant="danger">
                  Cancel session
                </Button>
              </form>
            </Card>
          )}

          {['scheduled', 'confirmed'].includes(appt.status) && (
            <Card>
              <h2 className="font-semibold">Move it</h2>
              <p className="mt-1 text-body text-muted">
                Moving a standing session detaches this week from the pattern. The rest of
                the series carries on, and the horizon will not refill this slot.
              </p>
              <form action={moveSession} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="appointmentId" value={appt.id} />
                <div>
                  <label htmlFor="date" className="block text-micro font-medium tracking-wide text-subtle uppercase">Date</label>
                  <input id="date" name="date" type="date" defaultValue={when.date} required
                    className="mt-1 rounded-[var(--radius)] border px-2 py-1.5 text-body"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface)' }} />
                </div>
                <div>
                  <label htmlFor="startMinute" className="block text-micro font-medium tracking-wide text-subtle uppercase">Start</label>
                  <select id="startMinute" name="startMinute" defaultValue={when.minutes}
                    className="mt-1 rounded-[var(--radius)] border px-2 py-1.5 text-body"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                    {Array.from({ length: 40 }, (_, i) => 8 * 60 + i * 15).map((m) => (
                      <option key={m} value={m}>{minutesToHHMM(m)}</option>
                    ))}
                  </select>
                </div>
                <button className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                  Move
                </button>
              </form>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 font-semibold">Progress note</h2>
            {appt.progressNote ? (
              <Link href={`/notes/${appt.progressNote.id}`} className="text-accent hover:underline">
                Open the note ({appt.progressNote.status})
              </Link>
            ) : canWriteNote ? (
              <form action={startProgressNote}>
                <input type="hidden" name="appointmentId" value={appt.id} />
                <button className="rounded-[var(--radius)] px-3 py-1.5 text-body font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
                  Start a progress note
                </button>
              </form>
            ) : (
              <p className="text-body text-muted">
                The clinical record for this session is written by {appt.clinician.name}.
              </p>
            )}
          </Card>

          {appt.joinLink && (
            <Card>
              <h2 className="mb-1 font-semibold">Telehealth</h2>
              <p className="font-mono text-caption break-all text-muted">{appt.joinLink}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
