import Link from 'next/link';
import { notFound } from 'next/navigation';
import { attendanceSummary } from '../../../../src/scheduling/lifecycle';
import { clientAffordances, clientTarget, effectiveFeeCents, getClient } from '../../../../src/clients/repository';
import { formStatus, listSubmissions } from '../../../../src/forms/service';
import { listProcessNotes, listProgressNotes } from '../../../../src/notes/service';
import { breakGlassWouldHelp, may } from '../../../../src/auth/guard';
import { prisma } from '../../../../src/db';
import { Forbidden, NotFound } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { localDateOf, minutesToHHMM, utcToZoned } from '../../../../src/time';
import {
  Badge, Card, EmptyState, Field, LockedPanel, PageHeader, StatusChip, TierBanner, money,
} from '../../../../src/ui/primitives';
import { addProcessNote, saveFee, saveLanguage, saveReminderStages, sendForm, sendPortalLink } from '../actions';
import { BreakGlassPrompt } from '../../break-glass';
import { systemClock } from '@/src/clock';
import { Button } from '@/src/ui/primitives';

export const dynamic = 'force-dynamic';

/** Staff-facing names for the cadence stages. `d5`/`d1`/`d0` are the rule's vocabulary, not front desk's. */
const STAGE_LABEL = { d5: 'Five days before', d1: 'Day before', d0: 'Day of' } as const;

/** The languages the practice has message bodies *and* a deny-list for. */
const LANGUAGE_LABEL = { en: 'English', es: 'Español' } as const;

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireSession();

  // Resolved once, coverage included, for the refusal and the affordances alike.
  const target = await clientTarget(id).catch((e) => {
    if (e instanceof NotFound) notFound();
    throw e;
  });

  let client;
  try {
    client = await getClient(actor, id);
  } catch (e) {
    if (!(e instanceof Forbidden)) throw e;
    const couldBreakGlass = breakGlassWouldHelp({ actor, action: 'read', resource: 'client', target });
    return couldBreakGlass ? (
      <BreakGlassPrompt resource="this client record" />
    ) : (
      <div className="mx-auto max-w-2xl py-8">
        <LockedPanel title="This is not one of your clients">
          Client records are open to the treating clinician and, where the clinician works
          under supervision, to their supervisor. You are neither for this record.
        </LockedPanel>
      </div>
    );
  }

  const can = clientAffordances(actor, target);
  const fee = await effectiveFeeCents(id);

  const upcoming = await prisma.appointment.findMany({
    where: { clientId: id, startAt: { gte: systemClock.now() }, status: { in: ['scheduled', 'confirmed'] } },
    select: { id: true, startAt: true, modality: true, status: true, room: { select: { name: true } } },
    orderBy: { startAt: 'asc' },
    take: 4,
  });

  const forms = await formStatus(actor, id).catch(() => null);
  const attendance = can.readAttendance ? await attendanceSummary(actor, id) : null;
  const submissions = can.readScreeners ? await listSubmissions(actor, id) : null;
  const progressNotes = can.readProgressNotes ? await listProgressNotes(actor, id).catch(() => null) : null;

  // Process notes are fetched only for their own author. There is no branch
  // here that fetches somebody else's and then hides them.
  const myProcessNotes = can.authorsProcessNotes ? await listProcessNotes(actor, id) : null;

  return (
    <>
      <PageHeader
        title={`${client.firstName} ${client.lastName}`}
        subtitle={
          <>
            <span className="font-mono">{client.code}</span> · treating clinician{' '}
            {client.treatingClinician.name}
            {client.departureAssignments.map((t) => (
              <span key={t.id} className="block">
                Transferred from {t.departure.user.name} to {t.receivingClinician?.name},{' '}
                {localDateOf(t.departure.executedAt!)}
              </span>
            ))}
          </>
        }
      />

      {!client.consents.complete && (
        <div
          className="mb-4 rounded-[var(--radius-lg)] border-2 px-4 py-3"
          style={{ borderColor: 'var(--warning)', background: 'var(--warning-soft)' }}
        >
          <p className="font-semibold">
            <span aria-hidden>⚠ </span>
            {client.consents.neverSent ? 'No consent has been sent' : 'Consent outstanding'}
          </p>
          <p className="mt-0.5 text-body">
            {client.consents.neverSent
              ? 'This client has never been sent a consent form.'
              : `Waiting on: ${client.consents.outstanding.map((c) => c.name).join(', ')}.`}{' '}
            Seeing a client without signed consent on file is a liability event.
          </p>
          <form action={sendForm} className="mt-2">
            <input type="hidden" name="clientId" value={client.id} />
            <input type="hidden" name="templateKey" value="consent-to-treat" />
            <button
              className="rounded-[var(--radius)] px-2.5 py-1 text-caption font-medium"
              style={{ background: 'var(--warning)', color: 'var(--surface-raised)' }}
            >
              Send consent form
            </button>
          </form>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card>
            <div className="mb-3">
              <TierBanner tier="operational">
                Contact details, fee and schedule. Everyone who books for this client sees this.
              </TierBanner>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <Field label="Date of birth">{localDateOf(client.dateOfBirth)}</Field>
              <Field label="Phone">{client.phone}</Field>
              <Field label="Email">{client.email}</Field>
              <Field label="Emergency contact">
                {client.emergencyContactName}
                {client.emergencyContactPhone ? ` · ${client.emergencyContactPhone}` : ''}
              </Field>
              <Field label="Session fee">
                {money(fee)}
                {client.feeCents !== null && <span className="ml-1"><Badge tone="info">sliding scale</Badge></span>}
              </Field>
              <Field label="Reminders">
                {client.reminderPreference === 'none'
                  ? <Badge tone="warning">None — do not message</Badge>
                  : client.reminderPreference}
                <span className="ml-1 text-caption text-subtle">
                  {client.reminderStages.length
                    ? `· ${client.reminderStages.map((s) => STAGE_LABEL[s]).join(', ')} only`
                    : '· practice cadence'}
                  {` · ${LANGUAGE_LABEL[client.language]}`}
                </span>
              </Field>
            </dl>

            {can.setFee && (
              <form action={saveFee} className="mt-4 flex items-end gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <input type="hidden" name="clientId" value={client.id} />
                <div>
                  <label htmlFor="feeDollars" className="block text-micro font-medium tracking-wide text-subtle uppercase">
                    Sliding-scale fee (blank for standard)
                  </label>
                  <input
                    id="feeDollars" name="feeDollars" inputMode="decimal"
                    defaultValue={client.feeCents === null ? '' : (client.feeCents / 100).toFixed(2)}
                    className="mt-1 w-32 rounded-[var(--radius)] border px-2 py-1 text-body"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                  />
                </div>
                <button className="rounded-[var(--radius)] border px-2.5 py-1.5 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                  Save fee
                </button>
              </form>
            )}

            {can.edit && (
              <form action={saveLanguage} className="mt-4 flex items-end gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <input type="hidden" name="clientId" value={client.id} />
                <div>
                  <label htmlFor="language" className="block text-micro font-medium tracking-wide text-subtle uppercase">
                    Language for messages
                  </label>
                  <select
                    id="language" name="language" defaultValue={client.language}
                    className="mt-1 rounded-[var(--radius)] border px-2 py-1 text-body"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                  >
                    {(['en', 'es'] as const).map((l) => (
                      <option key={l} value={l}>{LANGUAGE_LABEL[l]}</option>
                    ))}
                  </select>
                </div>
                <button className="rounded-[var(--radius)] border px-2.5 py-1.5 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                  Save language
                </button>
              </form>
            )}

            {can.edit && client.reminderPreference !== 'none' && (
              <form action={saveReminderStages} className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <input type="hidden" name="clientId" value={client.id} />
                <span className="block text-micro font-medium tracking-wide text-subtle uppercase">
                  When to ask this client
                </span>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {(['d5', 'd1', 'd0'] as const).map((stage) => (
                    <label key={stage} className="flex items-center gap-1.5 text-body">
                      <input
                        type="checkbox" name="stages" value={stage}
                        defaultChecked={client.reminderStages.includes(stage)}
                      />
                      {STAGE_LABEL[stage]}
                    </label>
                  ))}
                  <button className="rounded-[var(--radius)] border px-2.5 py-1.5 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                    Save cadence
                  </button>
                </div>
                <p className="mt-2 text-caption text-subtle">
                  Nothing ticked is the normal state: the practice cadence, which already
                  drops to the day before once this client has confirmed four times running.
                  Ticking boxes is the client&rsquo;s own answer instead, and the streak no
                  longer changes it.
                </p>
              </form>
            )}

            {can.edit && (
              <form action={sendPortalLink} className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <input type="hidden" name="clientId" value={client.id} />
                <button className="rounded-[var(--radius)] border px-2.5 py-1.5 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                  Send their appointments link
                </button>
                <span className="ml-2 text-caption text-subtle">
                  Their own schedule only. No notes, no forms, no fees.
                </span>
              </form>
            )}

            <p className="mt-3 border-t pt-3 text-caption text-subtle" style={{ borderColor: 'var(--border)' }}>
              <a href={`/clients/${client.id}/superbill`} className="font-medium underline">
                Superbill, year to date (CSV)
              </a>
              {' — completed sessions only, for the client to claim themselves. Carries no diagnosis code.'}
            </p>
          </Card>

          {progressNotes && (
            <Card>
              <div className="mb-3">
                <TierBanner tier="clinical">
                  The official record. The author, and the author&rsquo;s supervisor where one applies.
                </TierBanner>
              </div>
              <h2 className="mb-2 font-semibold">Progress notes</h2>
              {progressNotes.length === 0 ? (
                <p className="text-body text-muted">No progress notes yet.</p>
              ) : (
                <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {progressNotes.map((n) => (
                    <li key={n.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <Link href={`/notes/${n.id}`} className="font-medium text-accent hover:underline">
                          {n.appointment ? localDateOf(n.appointment.startAt) : localDateOf(n.createdAt)} session
                        </Link>
                        <p className="text-caption text-subtle">
                          {n.author.name}
                          {n._count.amendments > 0 && ` · ${n._count.amendments} amendment${n._count.amendments === 1 ? '' : 's'}`}
                        </p>
                      </div>
                      <NoteStatus status={n.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {myProcessNotes && (
            <Card>
              <div className="mb-3">
                <TierBanner tier="private">
                  Yours alone. No supervisor, manager, export or break-glass reaches these.
                </TierBanner>
              </div>
              <h2 className="mb-2 font-semibold">My process notes</h2>
              {myProcessNotes.length === 0 ? (
                <p className="text-body text-muted">Nothing here yet.</p>
              ) : (
                <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {myProcessNotes.map((n) => (
                    <li key={n.id} className="flex items-center justify-between py-2">
                      <Link href={`/process-notes/${n.id}`} className="text-accent hover:underline">
                        {localDateOf(n.createdAt)}
                      </Link>
                      {n.closedAt ? <Badge>Closed</Badge> : <Badge tone="accent">Open</Badge>}
                    </li>
                  ))}
                </ul>
              )}
              {can.isTreatingClinician && (
                <form action={addProcessNote} className="mt-3">
                  <input type="hidden" name="clientId" value={client.id} />
                  <label htmlFor="content" className="sr-only">New process note</label>
                  <textarea
                    id="content" name="content" rows={3}
                    placeholder="Your own working note about this session…"
                    className="w-full rounded-[var(--radius)] border p-2.5 font-serif text-lead leading-reading"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                  />
                  <Button variant="private" className="mt-2">
                    Save private note
                  </Button>
                </form>
              )}
            </Card>
          )}

          {/*
            The moment the whole project is about. A supervisor who can read this
            client's record, their screeners, their attendance and their progress
            notes -- and who countersigns those notes -- gets this here.
          */}
          {can.authorsProcessNotes && !can.isTreatingClinician && (
            <LockedPanel title={`Process notes by ${client.treatingClinician.name}`}>
              Process notes are the clinician&rsquo;s own working record and are visible only to
              the person who wrote them. That includes you as their supervisor, the practice
              manager, and break-glass access. This is a rule of the practice, not a
              permission you are missing.
            </LockedPanel>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 font-semibold">Next sessions</h2>
            {upcoming.length === 0 ? (
              <p className="text-body text-muted">Nothing booked. This client will appear in the continuity queue.</p>
            ) : (
              <ul className="space-y-1.5 text-body">
                {upcoming.map((a) => {
                  const when = utcToZoned(a.startAt);
                  return (
                    <li key={a.id} className="flex items-center justify-between gap-2">
                      <Link href={`/appointments/${a.id}`} className="text-accent hover:underline">
                        {when.date} {minutesToHHMM(when.minutes)}
                      </Link>
                      <span className="text-caption text-subtle">
                        {a.room?.name ?? 'Telehealth'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {forms && (
            <Card>
              <h2 className="mb-2 font-semibold">Forms</h2>
              <p className="mb-2 text-caption text-subtle">
                Status only. Answers are clinical and live on the clinician&rsquo;s side.
              </p>
              <ul className="space-y-1.5 text-body">
                {forms.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2">
                    <span>{f.template.name} <span className="text-subtle">v{f.template.version}</span></span>
                    {f.status === 'submitted'
                      ? <Badge tone="success" glyph="✓">Submitted</Badge>
                      : <Badge tone="warning">{f.status}</Badge>}
                  </li>
                ))}
                {forms.length === 0 && <li className="text-muted">Nothing sent yet.</li>}
              </ul>
              <form action={sendForm} className="mt-3 flex items-center gap-2">
                <input type="hidden" name="clientId" value={client.id} />
                <select name="templateKey" className="rounded-[var(--radius)] border px-2 py-1 text-caption" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}>
                  <option value="intake">New Client Intake</option>
                  <option value="consent-to-treat">Consent to Treatment</option>
                  <option value="wellbeing-check-in">Wellbeing Check-In</option>
                </select>
                <button className="rounded-[var(--radius)] border px-2.5 py-1 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                  Send
                </button>
              </form>
            </Card>
          )}

          {submissions && (
            <Card>
              <h2 className="mb-2 font-semibold">Screeners</h2>
              {submissions.length === 0 ? (
                <p className="text-body text-muted">No responses yet.</p>
              ) : (
                <ul className="space-y-2 text-body">
                  {submissions.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2">
                      <Link href={`/submissions/${s.id}`} className="text-accent hover:underline">
                        {localDateOf(s.createdAt)}
                      </Link>
                      <span className="flex items-center gap-1.5">
                        {s.totalScore !== null && <span className="font-mono text-caption text-muted">{s.totalScore}</span>}
                        {s.needsReview && <Badge tone="danger" glyph="◆">Review</Badge>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {submissions.length > 0 && (
                <p className="mt-3 border-t pt-2 text-caption" style={{ borderColor: 'var(--border)' }}>
                  <Link href={`/clients/${client.id}/trends`} className="text-accent hover:underline">
                    Screeners over time
                  </Link>
                </p>
              )}
            </Card>
          )}

          {attendance && (
            <Card>
              <h2 className="mb-2 font-semibold">Attendance</h2>
              <dl className="grid grid-cols-2 gap-2 text-body">
                <Field label="Completed">{attendance.completed}</Field>
                <Field label="Cancelled">{attendance.cancelled}</Field>
                <Field label="Late cancels">{attendance.lateCancelled}</Field>
                <Field label="No shows">{attendance.noShow}</Field>
                <Field label="Chargeable">{money(attendance.chargeableFeeCents)}</Field>
              </dl>
              <p className="mt-2 text-micro text-subtle">
                Visible to this client&rsquo;s clinician and the practice manager. Not to front desk.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function NoteStatus({ status }: { status: string }) {
  if (status === 'draft') return <Badge tone="warning">Draft</Badge>;
  if (status === 'signed') return <Badge tone="info" glyph="✍">Pending co-signature</Badge>;
  // P0-4b: falling through to "Co-signed" would have the record claim a
  // signature that does not exist. The hole is meant to be visible.
  if (status === 'abandoned') return <Badge tone="danger" glyph="⊘">Unsigned — author departed</Badge>;
  return <Badge tone="success" glyph="✓">Co-signed</Badge>;
}
