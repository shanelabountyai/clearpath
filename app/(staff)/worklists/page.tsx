import Link from 'next/link';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { continuityQueue, vacationImpact, waitlistMatches } from '../../../src/scheduling/worklists';
import { openRescheduleRequests } from '../../../src/portal/service';
import { handleRescheduleRequest } from './actions';
import { addDays, localDateOf, minutesToHHMM, utcToZoned, WEEKDAYS } from '../../../src/time';
import { Badge, Card, EmptyState, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

async function WorkListsPage() {
  const { actor } = await requireSession();
  const today = localDateOf(systemClock.now());

  const [continuity, absences] = await Promise.all([
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

  const waiting = await waitlistMatches(actor, { date: addDays(today, 1), startMinute: 15 * 60 }).catch(() => []);
  const rescheduleAsks = await openRescheduleRequests(actor).catch(() => []);

  return (
    <>
      <PageHeader title="Work lists" subtitle="Things that would otherwise hide" />
      <div className="mb-4"><TierBanner tier="operational" /></div>

      <div className="space-y-6">
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
          <h2 className="mb-2 text-subhead font-semibold">Waitlist</h2>
          <p className="mb-3 max-w-prose text-body text-muted">
            Who to offer a freed slot to. Clearpath surfaces candidates; a person rings them.
            Nothing here books itself.
          </p>
          {waiting.length === 0 ? (
            <EmptyState title="Nobody waiting for tomorrow afternoon" />
          ) : (
            <Card className="p-0">
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {waiting.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-body">
                    <Link href={`/clients/${w.client.id}`} className="font-medium text-accent hover:underline">
                      {w.client.lastName}, {w.client.firstName}
                    </Link>
                    <span className="text-muted">
                      {w.weekdays.length ? w.weekdays.map((d) => WEEKDAYS[d]).join(', ') : 'any day'}
                      {w.earliestMinute !== null ? ` · from ${minutesToHHMM(w.earliestMinute)}` : ''}
                      {' · '}{w.client.treatingClinician.name}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
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
