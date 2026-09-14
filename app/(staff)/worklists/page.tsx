import Link from 'next/link';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { continuityQueue, staleInquiries, unconfirmedSoon, vacationImpact, waitlistOpenings } from '../../../src/scheduling/worklists';
import { openRescheduleRequests } from '../../../src/portal/service';
import { openInboundReplies } from '../../../src/messaging/inbound';
import { handleRescheduleRequest, markInboundHandled } from './actions';
import { localDateOf, minutesToHHMM, utcToZoned, WEEKDAYS } from '../../../src/time';
import { Badge, Card, CONFIRMATION_META, EmptyState, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';
import { may } from '@/src/auth/guard';
import { departureWorklist } from '@/src/staff/departure';
import { leaveWorklist, uncoveredAbsenceAlerts, whileYouWereAway } from '@/src/staff/leave-plan';
import { dayLabel, plural } from '../departures/ui';

export const dynamic = 'force-dynamic';

async function WorkListsPage() {
  const { actor } = await requireSession();
  const [unconfirmed, continuity, staleAsks, absences] = await Promise.all([
    unconfirmedSoon(actor),
    continuityQueue(actor),
    staleInquiries(actor),
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

  const openings = await waitlistOpenings(actor).catch(() => []);
  const rescheduleAsks = await openRescheduleRequests(actor).catch(() => []);
  const wroteBack = await openInboundReplies(actor).catch(() => []);
  // Asked rather than caught: a clinician's `self` cell would refuse this read on
  // every visit, and a denial on the record per page load buries the real ones.
  const leaving = may({ actor, action: 'read', resource: 'departure' }) ? await departureWorklist(actor) : [];
  const away = may({ actor, action: 'read', resource: 'leave' }) ? await leaveWorklist(actor) : [];
  // P1-1 is for whoever can fix it, and the fix is recording a leave.
  const uncovered = may({ actor, action: 'create', resource: 'leave' }) ? await uncoveredAbsenceAlerts(actor) : 0;
  const back = await whileYouWereAway(actor);

  return (
    <>
      <PageHeader title="Work lists" subtitle="Things that would otherwise hide" />
      <div className="mb-4"><TierBanner tier="operational" /></div>

      <div className="space-y-6">
        {back && (
          <section>
            <h2 className="mb-2 text-subhead font-semibold">While you were away</h2>
            <p className="mb-3 max-w-prose text-body text-muted">
              {dayLabel(back.fromDate)} to {dayLabel(back.toDate)}, {back.coverer} covering. What happened on your
              caseload in those days, shown for two weeks after you are back. A colleague&apos;s private notes
              from covering are theirs, and are not here.
            </p>
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {back.flagged.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                    <span>
                      <Link href={`/submissions/${s.id}`} className="font-medium text-accent hover:underline">{s.template.name}</Link>
                      <span className="ml-2 text-muted">{s.client.code} · {dayLabel(localDateOf(s.request.submittedAt!))}</span>
                    </span>
                    <Badge tone="danger" glyph="!">flagged for review</Badge>
                  </li>
                ))}
                {back.sessions.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                    <span>
                      Session with {a.clinician.name}
                      <span className="ml-2 text-muted">{a.client.code} · {dayLabel(localDateOf(a.startAt))}</span>
                    </span>
                    <Badge tone="neutral">{a.status.replace('_', ' ')}</Badge>
                  </li>
                ))}
                {back.notes.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                    <span>
                      <Link href={`/notes/${n.id}`} className="font-medium text-accent hover:underline">Progress note by {n.author.name}</Link>
                      <span className="ml-2 text-muted">{n.client.code} · {dayLabel(localDateOf(n.appointment.startAt))}</span>
                    </span>
                    <Badge tone={n.status === 'draft' ? 'warning' : 'neutral'}>{n.status}</Badge>
                  </li>
                ))}
                {back.flagged.length + back.sessions.length + back.notes.length === 0 && (
                  <li className="px-4 py-3 text-body text-muted">Nothing on your caseload needed anybody while you were away.</li>
                )}
              </ul>
            </Card>
          </section>
        )}
        <section>
          <h2 className="mb-2 text-subhead font-semibold">Nobody has said they are coming</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            Sessions in the next 48 hours with no answer on them, soonest first. The
            number is here because ringing them is the job — and because silence only
            becomes a fee if somebody had the chance to make this call.
          </p>
          {unconfirmed.length === 0 ? (
            <EmptyState title="Every session in the next two days is answered for">
              Sessions appear here as they come inside the window without a reply.
            </EmptyState>
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {unconfirmed.map((a) => {
                  const when = utcToZoned(a.startAt);
                  const meta = CONFIRMATION_META[a.confirmation]!;
                  return (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                      <span>
                        <Link href={`/appointments/${a.id}`} className="font-medium text-accent hover:underline">
                          {a.client.lastName}, {a.client.firstName}
                        </Link>{' '}
                        <span className="font-mono text-caption text-subtle">{a.client.code}</span>
                        <span className="ml-2 text-muted">
                          {WEEKDAYS[when.weekday]} {when.date} {minutesToHHMM(when.minutes)} · {a.clinician.name}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        {a.client.phone
                          ? <span className="font-mono text-body">{a.client.phone}</span>
                          : <span className="text-caption text-subtle">no number on file</span>}
                        {a.client.reminderPreference === 'none' && <Badge tone="warning">call only</Badge>}
                        <Badge tone={meta.tone} glyph={meta.glyph}>{meta.label}</Badge>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>

        {leaving.length > 0 && (
          <section>
            <h2 className="mb-2 text-subhead font-semibold">Somebody is leaving</h2>
            <p className="mb-3 max-w-prose text-body text-muted">
              Every notice still running, soonest last day first, with what stands between the
              plan and that day. Counts only: the plan is where clients are named and where each
              item gets fixed. Unsigned notes do not stop a departure &mdash; they become notes
              nobody may ever sign, so the days left are the point.
            </p>
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {leaving.map((d) => {
                  const b = d.blocking;
                  const items = [
                    b.undecided && `${plural(b.undecided, 'client')} undecided`,
                    b.receiver_unavailable && `${plural(b.receiver_unavailable, 'transfer')} nobody can take`,
                    b.hour_clash && `${plural(b.hour_clash, 'session')} clashing`,
                    b.unread_alert && plural(b.unread_alert, 'unread alert'),
                    b.supervisee_unassigned && `${plural(b.supervisee_unassigned, 'associate')} unsupervised`,
                    b.leave_open && 'a leave not yet ended',
                  ].filter((x): x is string => !!x);
                  return (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                      <span>
                        <Link href={`/departures/${d.id}`} className="font-medium text-accent hover:underline">{d.name}</Link>
                        <span className="ml-2 text-muted">
                          last day {dayLabel(d.lastDayOn)} ·{' '}
                          {d.daysLeft < 0 ? 'passed' : d.daysLeft === 0 ? 'today' : `${plural(d.daysLeft, 'day')} left`}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        {items.length === 0
                          ? <Badge tone="success" glyph="✓">ready to execute</Badge>
                          : items.map((i) => <Badge key={i} tone="danger" glyph="!">{i}</Badge>)}
                        {d.unsignedNotes > 0 && <Badge tone="warning">{plural(d.unsignedNotes, 'unsigned note')}</Badge>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </section>
        )}

        {(away.length > 0 || uncovered > 0) && (
          <section>
            <h2 className="mb-2 text-subhead font-semibold">Somebody is away</h2>
            <p className="mb-3 max-w-prose text-body text-muted">
              Every leave not yet over, soonest first. Counts only: the plan is where clients are
              named and where coverage is changed. Unread alerts still with the person away go to
              whoever covers on the leave&apos;s first day &mdash; better read before they go.
            </p>
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {uncovered > 0 && (
                  <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                    <span>
                      Away today with no leave recorded, so nobody covers.{' '}
                      <Link href="/leave" className="text-accent hover:underline">Record a leave</Link>
                    </span>
                    <Badge tone="danger" glyph="!">{plural(uncovered, 'unread alert')} nobody covers</Badge>
                  </li>
                )}
                {away.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                    <span>
                      <Link href={`/leave/${l.id}`} className="font-medium text-accent hover:underline">{l.name}</Link>
                      <span className="ml-2 text-muted">
                        {l.phase === 'active' ? `until ${dayLabel(l.toDate)}` : `${dayLabel(l.fromDate)} to ${dayLabel(l.toDate)}`}
                        {' · '}covering: {l.coverer} · {plural(l.clients, 'client')}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      {l.unavailableCoverers > 0 && (
                        <Badge tone="danger" glyph="!">{plural(l.unavailableCoverers, 'coverer')} not here for all of it</Badge>
                      )}
                      {l.unreadAlerts > 0 && (l.phase === 'active'
                        ? <Badge tone="danger" glyph="!">{plural(l.unreadAlerts, 'unread alert')} not yet moved</Badge>
                        : <Badge tone="warning">{plural(l.unreadAlerts, 'unread alert')} move on day one</Badge>)}
                      {l.supervisionBlocked && <Badge tone="danger" glyph="!">supervision uncovered</Badge>}
                      {l.unavailableCoverers === 0 && l.unreadAlerts === 0 && !l.supervisionBlocked
                        && <Badge tone="success" glyph="✓">covered</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-subhead font-semibold">Clients who wrote back — call them</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            A client replied to a reminder in words rather than tapping the link. The
            message was read once, classified, and dropped: it is not stored here, in the
            audit log, or anywhere else, because a reply to this number could be anything.
            Their clinician has been told that they wrote. Ring them and ask.
          </p>
          {wroteBack.length === 0 ? (
            <EmptyState title="Nobody has written in" />
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {wroteBack.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body">
                    <span>
                      <Link href={`/clients/${r.clientId}`} className="font-medium text-accent hover:underline">
                        {r.client.lastName}, {r.client.firstName}
                      </Link>{' '}
                      <span className="font-mono text-caption text-subtle">{r.client.code}</span>
                      {r.appointment && (
                        <span className="ml-2 text-muted">
                          about {WEEKDAYS[utcToZoned(r.appointment.startAt).weekday]}{' '}
                          {utcToZoned(r.appointment.startAt).date}{' '}
                          {minutesToHHMM(utcToZoned(r.appointment.startAt).minutes)}
                          {' · '}{r.appointment.clinician.name}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      {r.client.phone
                        ? <span className="font-mono text-body">{r.client.phone}</span>
                        : <span className="text-caption text-subtle">no number on file</span>}
                      <form action={markInboundHandled}>
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
          <h2 className="mb-2 text-subhead font-semibold">Calls nobody has closed out</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            Open inquiries three days old or more, oldest first. An unreturned call is the
            same category of failure as a client with nothing booked — it just doesn&apos;t
            have a record to go quiet in.
          </p>
          {staleAsks.length === 0 ? (
            <EmptyState title="No open inquiry is more than three days old">
              Calls appear here as they age past the window without being converted or discarded.
            </EmptyState>
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {staleAsks.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-body">
                    <span className="flex items-center gap-2 font-medium">
                      {i.lastName}, {i.firstName}
                      {i.requestedClinician && (
                        <span className="font-normal text-muted">asked for {i.requestedClinician.name}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      {i.phone
                        ? <span className="font-mono text-body">{i.phone}</span>
                        : <span className="text-caption text-subtle">no number on file</span>}
                      <Badge tone={i.daysSince > 7 ? 'danger' : 'warning'}>{i.daysSince} days old</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
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

        <section>
          <h2 className="mb-2 text-subhead font-semibold">Hours going spare — and who wants one</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            Two different offers, deliberately not merged. A <strong>cancelled</strong> hour
            is free. A <strong>declined</strong> one is still on the books: the client has
            said they are not coming, but nobody has cancelled it yet, so it is two calls —
            them first, then the person you are offering it to. Clearpath surfaces
            candidates; a person rings them. Nothing here books itself.
          </p>
          {openings.length === 0 ? (
            <EmptyState title="Nothing going spare in the next month">
              Cancellations and declines appear here as they land, with the waitlist matched
              against the hour.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {openings.map((o) => {
                const when = utcToZoned(o.startAt);
                return (
                  <Card key={o.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-semibold">
                        {WEEKDAYS[when.weekday]} {when.date} {minutesToHHMM(when.minutes)}
                        <span className="ml-2 font-normal text-muted">{o.clinician.name}</span>
                        {o.room && <span className="ml-2 font-normal text-subtle">{o.room.name}</span>}
                      </h3>
                      <span className="flex items-center gap-2">
                        <Badge tone="neutral">
                          {o.noticeHours >= 48
                            ? `${Math.floor(o.noticeHours / 24)} days notice`
                            : `${o.noticeHours} hours notice`}
                        </Badge>
                        {o.freed ? (
                          <Badge tone="success" glyph="○">hour is free</Badge>
                        ) : (
                          <Badge tone="warning" glyph="!">declined — still on the books</Badge>
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-caption text-subtle">
                      {o.freed ? 'Was ' : 'Held by '}
                      <Link href={`/appointments/${o.id}`} className="text-accent hover:underline">
                        {o.client.lastName}, {o.client.firstName}
                      </Link>{' '}
                      <span className="font-mono">{o.client.code}</span>
                      {o.declineReason && ` · ${o.declineReason.replace(/_/g, ' ')}`}
                    </p>
                    {o.matches.length === 0 ? (
                      <p className="mt-2 text-body text-muted">Nobody on the waitlist wants this hour.</p>
                    ) : (
                      <ul className="mt-2 divide-y" style={{ borderColor: 'var(--border)' }}>
                        {o.matches.map((w) => (
                          <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-body">
                            {w.client ? (
                              <Link href={`/clients/${w.client.id}`} className="font-medium text-accent hover:underline">
                                {w.client.lastName}, {w.client.firstName}
                              </Link>
                            ) : w.inquiry ? (
                              // Not a link: there is no record to open, which is
                              // the whole point of the stage. A name and a number
                              // is what front desk needs to ring a stranger.
                              <span className="flex items-center gap-2 font-medium">
                                {w.inquiry.lastName}, {w.inquiry.firstName}
                                <Badge tone="neutral">inquiry</Badge>
                              </span>
                            ) : null}
                            <span className="flex items-center gap-2 text-muted">
                              {w.weekdays.length ? w.weekdays.map((d) => WEEKDAYS[d]).join(', ') : 'any day'}
                              {w.earliestMinute !== null ? ` · from ${minutesToHHMM(w.earliestMinute)}` : ''}
                              {w.client && <>{' · '}{w.client.treatingClinician.name}</>}
                              {w.inquiry?.phone && <span className="font-mono">{w.inquiry.phone}</span>}
                              {w.client?.reminderPreference === 'none' && <Badge tone="warning">call only</Badge>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                );
              })}
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
    'Continuity gaps, vacation reschedules and waitlist matches are scheduling work. They belong to front desk and the practice manager.',
});
