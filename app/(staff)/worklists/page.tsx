import Link from 'next/link';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { continuityQueue, unconfirmedSoon, vacationImpact, waitlistOpenings } from '../../../src/scheduling/worklists';
import { openRescheduleRequests } from '../../../src/portal/service';
import { openInboundReplies } from '../../../src/messaging/inbound';
import { handleRescheduleRequest, markInboundHandled } from './actions';
import { localDateOf, minutesToHHMM, utcToZoned, WEEKDAYS } from '../../../src/time';
import { Badge, Card, CONFIRMATION_META, EmptyState, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

async function WorkListsPage() {
  const { actor } = await requireSession();
  const [unconfirmed, continuity, absences] = await Promise.all([
    unconfirmedSoon(actor),
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

  const openings = await waitlistOpenings(actor).catch(() => []);
  const rescheduleAsks = await openRescheduleRequests(actor).catch(() => []);
  const wroteBack = await openInboundReplies(actor).catch(() => []);

  return (
    <>
      <PageHeader title="Work lists" subtitle="Things that would otherwise hide" />
      <div className="mb-4"><TierBanner tier="operational" /></div>

      <div className="space-y-6">
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
                            <Link href={`/clients/${w.client.id}`} className="font-medium text-accent hover:underline">
                              {w.client.lastName}, {w.client.firstName}
                            </Link>
                            <span className="flex items-center gap-2 text-muted">
                              {w.weekdays.length ? w.weekdays.map((d) => WEEKDAYS[d]).join(', ') : 'any day'}
                              {w.earliestMinute !== null ? ` · from ${minutesToHHMM(w.earliestMinute)}` : ''}
                              {' · '}{w.client.treatingClinician.name}
                              {w.client.reminderPreference === 'none' && <Badge tone="warning">call only</Badge>}
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
