import Link from 'next/link';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { continuityQueue, freedSlots, unconfirmedSoon, unreachableClients, vacationImpact } from '../../../src/scheduling/worklists';
import { openRescheduleRequests } from '../../../src/portal/service';
import { handleRescheduleRequest, handleInboundReplyCall } from './actions';
import { openInboundReplies } from '../../../src/messaging/inbound';
import { addDays, localDateOf, minutesToHHMM, utcToZoned, WEEKDAYS } from '../../../src/time';
import { Badge, Card, EmptyState, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

async function WorkListsPage() {
  const { actor } = await requireSession();
  const today = localDateOf(systemClock.now());

  const [replies, unconfirmed, unreachable, continuity, absences] = await Promise.all([
    openInboundReplies(actor),
    unconfirmedSoon(actor, { clock: systemClock, withinHours: 48 }),
    unreachableClients(actor, { clock: systemClock }),
    continuityQueue(actor),
    prisma.availabilityOverride.findMany({
      where: { kind: 'unavailable', toDate: { gte: systemClock.now() } },
      select: { userId: true, fromDate: true, toDate: true, reason: true, user: { select: { name: true } } },
      orderBy: { fromDate: 'asc' },
    }),
  ]);

  const displaced = await Promise.all(
    absences.map(async (a) => ({
      absence: a,
      sessions: await vacationImpact(actor, {
        clinicianId: a.userId,
        fromDate: localDateOf(a.fromDate),
        toDate: localDateOf(a.toDate),
      }),
    })),
  );

  // No `.catch(() => [])` here. The call this replaced had one, and it was
  // swallowing a real authorization denial for therapists rather than
  // reporting it — an empty waitlist and a refused read looked identical.
  const freed = await freedSlots(actor, { clock: systemClock });
  const rescheduleAsks = await openRescheduleRequests(actor).catch(() => []);

  return (
    <>
      <PageHeader title="Work lists" subtitle="Things that would otherwise hide" />
      <div className="mb-4"><TierBanner tier="operational" /></div>

      <div className="space-y-6">
        {/* P1-3. Above everything, and short by design: a client wrote
            something this system could not understand, and the only thing to
            do about it is ring them. There is nothing here to read because
            nothing was kept. */}
        {replies.length > 0 && (
          <section>
            <h2 className="mb-2 text-subhead font-semibold">Clients who replied — call them</h2>
            <p className="mb-3 max-w-prose text-body text-muted">
              They texted back in words. The message was not stored and cannot be shown
              to you: a reply to a reminder can contain anything, and this desk is not
              where that should land. Their clinician has been told separately.
            </p>
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {replies.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <span className="text-body">
                      <Link href={`/clients/${r.client.id}`} className="font-medium text-accent hover:underline">
                        {r.client.lastName}, {r.client.firstName}
                      </Link>
                      <span className="ml-1.5 font-mono text-caption text-subtle">{r.client.code}</span>
                      <span className="ml-2 text-muted">
                        replied {localDateOf(r.receivedAt)} · {r.client.treatingClinician.name}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      {r.client.phone
                        ? <a href={`tel:${r.client.phone}`} className="font-mono text-caption text-accent hover:underline">{r.client.phone}</a>
                        : <span className="text-caption text-subtle">no number on file</span>}
                      <form action={handleInboundReplyCall}>
                        <input type="hidden" name="replyId" value={r.id} />
                        <button
                          className="rounded-[var(--radius)] border px-2 py-1 text-caption font-medium"
                          style={{ borderColor: 'var(--border-strong)' }}
                        >
                          Called them
                        </button>
                      </form>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )}

        {/* P2. The other half of the delivery precondition. Once the fee needs
            a delivery receipt, a client with a dead number stops being charged
            — correctly, and completely silently. Without this section the
            practice would simply stop reaching them, keep booking them, and
            find out when they stopped coming. */}
        {unreachable.length > 0 && (
          <section>
            <h2 className="mb-2 text-subhead font-semibold">Clients we cannot reach — check their details</h2>
            <p className="mb-3 max-w-prose text-body text-muted">
              The carrier could not deliver to these clients. They are exempt from the
              no-show fee for as long as that is true — the practice failed to ask, so
              there is nothing to charge for — but they are also not getting reminders.
              A client drops off this list on their own the moment a message reaches them.
            </p>
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {unreachable.map((u) => (
                  <li key={u.client.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <span className="text-body">
                      <Link href={`/clients/${u.client.id}`} className="font-medium text-accent hover:underline">
                        {u.client.lastName}, {u.client.firstName}
                      </Link>
                      <span className="ml-1.5 font-mono text-caption text-subtle">{u.client.code}</span>
                      <span className="ml-2 text-muted">
                        {u.failures === 1 ? 'one message' : `${u.failures} messages`} undelivered
                        {u.lastFailureAt ? `, last ${localDateOf(u.lastFailureAt)}` : ''}
                        {' · '}{u.treatingClinician.name}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      {/* The address that failed, so the fix is obvious: the one
                          on file for the channel the practice was using. */}
                      <span className="font-mono text-caption text-subtle">
                        {u.channel === 'sms' ? (u.client.phone ?? 'no number on file') : (u.client.email ?? 'no address on file')}
                      </span>
                      {u.client.phone && u.channel !== 'sms' && (
                        <a href={`tel:${u.client.phone}`} className="font-mono text-caption text-accent hover:underline">
                          {u.client.phone}
                        </a>
                      )}
                      <Badge tone="danger">{(u.failureCode ?? 'undelivered').replace(/_/g, ' ')}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )}

        {/* P1-1. First on the page, because it is the list with a deadline on
            it: every row is a session starting inside two days that nobody has
            answered for, and the work is a phone call. */}
        <section>
          <h2 className="mb-2 text-subhead font-semibold">Unconfirmed, starting soon</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            Oldest start first. Clients marked <em>never asked</em> get no reminders and
            can never be charged for silence — which makes them the ones to ring.
          </p>
          {unconfirmed.length === 0 ? (
            <EmptyState title="Everything in the next two days is answered for" />
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {unconfirmed.map((u) => {
                  const when = utcToZoned(u.startAt);
                  return (
                    <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                      <span className="text-body">
                        <Link href={`/appointments/${u.id}`} className="font-medium text-accent hover:underline">
                          {u.client.lastName}, {u.client.firstName}
                        </Link>
                        <span className="ml-1.5 font-mono text-caption text-subtle">{u.client.code}</span>
                        <span className="ml-2 text-muted">
                          {WEEKDAYS[when.weekday]} {when.date} {minutesToHHMM(when.minutes)} · {u.clinician.name}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        {/* The number is the whole point of the list. */}
                        {u.client.phone
                          ? <a href={`tel:${u.client.phone}`} className="font-mono text-caption text-accent hover:underline">{u.client.phone}</a>
                          : <span className="text-caption text-subtle">no number on file</span>}
                        {u.neverAsked
                          ? <Badge tone="warning" glyph="✆">never asked</Badge>
                          : <Badge tone="neutral">{u.stagesSent.length} of 3 sent</Badge>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-subhead font-semibold">Clients asking to move a session</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            Raised by clients through their own link. A reason code and a time, never a
            message — the conversation happens on the phone, not in a text box that
            reaches this desk.
          </p>
          {rescheduleAsks.length === 0 ? (
            <EmptyState title="Nothing waiting">
              Requests appear here as clients raise them. Nothing is ever moved automatically.
            </EmptyState>
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {rescheduleAsks.map((r) => {
                  const when = utcToZoned(r.appointment.startAt);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                      <span className="text-body">
                        <Link href={`/clients/${r.clientId}`} className="text-accent hover:underline">
                          {r.client.firstName} {r.client.lastName}
                        </Link>
                        <span className="ml-1.5 font-mono text-caption text-subtle">{r.client.code}</span>
                        <span className="ml-2 text-muted">
                          {WEEKDAYS[when.weekday]} {when.date} {minutesToHHMM(when.minutes)} · {r.appointment.clinician.name}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge tone="info">{r.reason.replace(/_/g, ' ')}</Badge>
                        <form action={handleRescheduleRequest} className="flex gap-1.5">
                          <input type="hidden" name="requestId" value={r.id} />
                          <button
                            name="status" value="handled"
                            className="rounded-[var(--radius)] border px-2 py-1 text-caption font-medium"
                            style={{ borderColor: 'var(--border-strong)' }}
                          >
                            Handled
                          </button>
                          <button
                            name="status" value="declined"
                            className="rounded-[var(--radius)] border px-2 py-1 text-caption"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            Declined
                          </button>
                        </form>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-subhead font-semibold">Reschedules from clinician absence</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            A week off against standing weekly clients is not one gap, it is a set of
            conversations. Each of these needs a person, not an algorithm.
          </p>
          {displaced.every((d) => d.sessions.length === 0) ? (
            <EmptyState title="Nobody is away with sessions booked" />
          ) : (
            displaced
              .filter((d) => d.sessions.length > 0)
              .map((d) => (
                <Card key={d.absence.userId + d.absence.fromDate.toISOString()} className="mb-3">
                  <h3 className="font-semibold">
                    {d.absence.user.name} · {localDateOf(d.absence.fromDate)} to {localDateOf(d.absence.toDate)}
                    <span className="ml-2 font-normal text-muted">{d.absence.reason}</span>
                  </h3>
                  <ul className="mt-2 divide-y" style={{ borderColor: 'var(--border)' }}>
                    {d.sessions.map((s) => {
                      const when = utcToZoned(s.startAt);
                      return (
                        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-body">
                          <span>
                            <Link href={`/appointments/${s.id}`} className="font-medium text-accent hover:underline">
                              {s.client.lastName}, {s.client.firstName}
                            </Link>{' '}
                            <span className="font-mono text-caption text-subtle">{s.client.code}</span>
                          </span>
                          <span className="flex items-center gap-2 text-muted">
                            {WEEKDAYS[when.weekday]} {when.date} {minutesToHHMM(when.minutes)}
                            {s.standing && <Badge tone="info" glyph="↻">standing</Badge>}
                            {s.client.reminderPreference === 'none' && <Badge tone="warning">call only</Badge>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              ))
          )}
        </section>

        <section>
          <h2 className="mb-2 text-subhead font-semibold">Continuity of care</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            Clients whose last session completed and who have nothing booked. People leave
            therapy quietly; this is the list that says so out loud.
          </p>
          {continuity.length === 0 ? (
            <EmptyState title="No continuity gaps">Everyone with a completed session has a next one booked.</EmptyState>
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {continuity.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-body">
                    <span>
                      <Link href={`/clients/${c.id}`} className="font-medium text-accent hover:underline">
                        {c.lastName}, {c.firstName}
                      </Link>{' '}
                      <span className="font-mono text-caption text-subtle">{c.code}</span>
                      <span className="ml-2 text-muted">{c.treatingClinician.name}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {c.reminderPreference === 'none' && <Badge tone="warning">no messages — call</Badge>}
                      <Badge tone={(c.daysSince ?? 0) > 56 ? 'danger' : 'neutral'}>
                        {c.daysSince} days since last session
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>

        {/* P2-2. The confirmation loop's other half. Every other list on this
            page protects the practice from something; this one is the only one
            that is worth something to a client — somebody who has been waiting
            weeks gets the hour a decline handed back. Nothing here books, and
            there is no button to mark an opening as handled: a slot leaves this
            list when the hour is filled, the clinician stops working it, or it
            starts. */}
        <section>
          <h2 className="mb-2 text-subhead font-semibold">Freed hours — offer them</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            Sessions cancelled ahead of time, and the waiting clients who could take one.
            A client is only ever offered their own clinician&rsquo;s hour. Clearpath surfaces
            candidates; a person rings them. Nothing here books itself.
          </p>
          {freed.length === 0 ? (
            <EmptyState title="No freed hours in the next 30 days" />
          ) : (
            <div className="space-y-3">
              {freed.map((slot) => (
                <Card key={slot.appointmentId} className="p-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-body font-medium">
                      {WEEKDAYS[slot.weekday]} {slot.date} · {minutesToHHMM(slot.startMinute)}
                      <span className="text-muted"> · {slot.clinician.name}</span>
                      {slot.room ? <span className="text-muted"> · {slot.room.name}</span> : null}
                      {slot.modality === 'telehealth' ? <span className="text-muted"> · telehealth</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      {slot.confirmation === 'declined' ? <Badge tone="info">Client declined</Badge> : null}
                      {/* Notice remaining, never hidden and never a filter. The
                          two-hour slot is on the list too, ranked last and
                          labelled for what it is. */}
                      <Badge tone={slot.fillability === 'ample' ? 'success' : slot.fillability === 'tight' ? 'warning' : 'neutral'}>
                        {slot.notice} notice
                      </Badge>
                    </span>
                  </div>
                  {slot.candidates.length === 0 ? (
                    <p className="px-4 py-3 text-body text-muted">
                      Nobody on the waitlist can take this one. It stays here anyway — an
                      empty hour nobody is looking at is the thing this list exists to prevent.
                    </p>
                  ) : (
                    <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                      {slot.candidates.map((w) => (
                        <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-body">
                          <Link href={`/clients/${w.client.id}`} className="font-medium text-accent hover:underline">
                            {w.client.lastName}, {w.client.firstName}
                          </Link>
                          <span className="text-muted">
                            {/* The number is the feature: the only thing to do
                                with this list is ring somebody. */}
                            {w.client.phone ?? 'no number on file'}
                            {' · waiting since '}{localDateOf(w.createdAt)}
                            {w.weekdays.length ? ` · ${w.weekdays.map((d) => WEEKDAYS[d]).join(', ')}` : ' · any day'}
                            {w.earliestMinute !== null ? ` · from ${minutesToHHMM(w.earliestMinute)}` : ''}
                            {w.latestMinute !== null ? ` · until ${minutesToHHMM(w.latestMinute)}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              ))}
            </div>
          )}
        </section>

      </div>
    </>
  );
}

export default withDenial(WorkListsPage, {
  title: 'Front-desk work lists',
  children:
    'Unconfirmed sessions, undelivered reminders, continuity gaps, vacation reschedules and waitlist matches are scheduling work. They belong to front desk and the practice manager.',
});
