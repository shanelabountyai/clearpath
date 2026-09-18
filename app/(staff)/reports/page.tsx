import { requireSession } from '../../../src/session';
import { confirmationReport, utilizationReport, weeklyVolume } from '../../../src/reports/utilization';
import { referralReport } from '../../../src/reports/intake';
import { addDays, localDateOf } from '../../../src/time';
import { Card, money, PageHeader, ScrollX } from '../../../src/ui/primitives';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';
import { abandonedNotesByDeparture } from '@/src/staff/departure';
import { dayLabel } from '../departures/ui';

export const dynamic = 'force-dynamic';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { actor } = await requireSession();
  const q = await searchParams;
  const to = q.to ?? localDateOf(systemClock.now());
  const from = q.from ?? addDays(to, -90);

  const [report, weeks, confirmations, referrals, abandoned] = await Promise.all([
    utilizationReport(actor, { from, to }),
    weeklyVolume(actor, { from, to }),
    confirmationReport(actor, { from, to }),
    referralReport(actor, { from, to }),
    abandonedNotesByDeparture(actor),
  ]);

  const maxWeekly = Math.max(1, ...weeks.map((w) => w.sessions));

  return (
    <>
      <PageHeader
        title="Practice report"
        subtitle={`${from} to ${to}`}
        actions={
          <form className="flex items-end gap-2">
            <input type="date" name="from" defaultValue={from} className="rounded-[var(--radius)] border px-2 py-1.5 text-body" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }} />
            <input type="date" name="to" defaultValue={to} className="rounded-[var(--radius)] border px-2 py-1.5 text-body" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }} />
            <button className="rounded-[var(--radius)] px-3 py-1.5 text-body font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>Apply</button>
          </form>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sessions booked" value={report.totals.booked} />
        <Stat label="Completed" value={report.totals.completed} />
        <Stat label="No-show rate" value={pct(report.rates.noShow)} tone={report.rates.noShow > 0.1 ? 'danger' : undefined} />
        <Stat label="Late-cancel rate" value={pct(report.rates.lateCancel)} tone={report.rates.lateCancel > 0.1 ? 'danger' : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-semibold">Room utilization</h2>
          <p className="mb-3 text-caption text-muted">
            Against the practice&rsquo;s own working day — eight hours per weekday — rather than
            against the clock, which would make a full practice look half empty.
          </p>
          <ul className="space-y-2.5">
            {report.rooms.map((r) => (
              <li key={r.id}>
                <div className="mb-1 flex items-baseline justify-between text-body">
                  <span>{r.name}</span>
                  <span className="font-mono text-muted">{pct(r.utilization)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--surface-inset)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, r.utilization * 100)}%`, background: 'var(--accent)' }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold">Sessions by clinician</h2>
          <ScrollX label="Sessions by clinician">
            <table className="w-full min-w-[380px] border-collapse text-body">
              <thead>
                <tr className="text-left text-muted">
                  <th className="border-b py-1.5 font-medium" style={{ borderColor: 'var(--border)' }}>Clinician</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>Completed</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>No show</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>Late cancel</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>Telehealth</th>
                </tr>
              </thead>
              <tbody>
                {report.clinicians.map((c) => (
                  <tr key={c.id}>
                    <td className="border-b py-1.5" style={{ borderColor: 'var(--border)' }}>{c.name}</td>
                    <td className="border-b py-1.5 text-right font-mono" style={{ borderColor: 'var(--border)' }}>{c.completed}</td>
                    <td className="border-b py-1.5 text-right font-mono" style={{ borderColor: 'var(--border)' }}>{c.noShow}</td>
                    <td className="border-b py-1.5 text-right font-mono" style={{ borderColor: 'var(--border)' }}>{c.lateCancelled}</td>
                    <td className="border-b py-1.5 text-right font-mono" style={{ borderColor: 'var(--border)' }}>{c.telehealth}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="mb-1 font-semibold">Confirmations</h2>
          <p className="mb-3 text-caption text-muted">
            The rate is answered out of asked-and-settled — {confirmations.totals.confirmed} of{' '}
            {confirmations.totals.confirmed + confirmations.totals.declined + confirmations.totals.noResponse}.
            Sessions nobody was asked about ({confirmations.totals.notRequired}) are excluded rather
            than counted as misses, and {confirmations.totals.pending} are still in flight.
          </p>
          <ScrollX label="Confirmations by clinician">
            <table className="w-full min-w-[520px] border-collapse text-body">
              <thead>
                <tr className="text-left text-muted">
                  <Th>Clinician</Th>
                  <Th right>Confirmed</Th>
                  <Th right>Declined</Th>
                  <Th right>No response</Th>
                  <Th right>Not asked</Th>
                  <Th right>Rate</Th>
                  <Th right>Fee from silence</Th>
                </tr>
              </thead>
              <tbody>
                {confirmations.clinicians.map((c) => (
                  <tr key={c.id}>
                    <Td>{c.name}</Td>
                    <Td right>{c.confirmed}</Td>
                    <Td right>{c.declined}</Td>
                    <Td right>{c.noResponse}</Td>
                    <Td right>{c.notRequired}</Td>
                    <Td right>{pct(c.rate)}</Td>
                    <Td right>{money(c.feeCents)}</Td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <Td>Practice</Td>
                  <Td right>{confirmations.totals.confirmed}</Td>
                  <Td right>{confirmations.totals.declined}</Td>
                  <Td right>{confirmations.totals.noResponse}</Td>
                  <Td right>{confirmations.totals.notRequired}</Td>
                  <Td right>{pct(confirmations.totals.rate)}</Td>
                  <Td right>{money(confirmations.totals.feeCents)}</Td>
                </tr>
              </tbody>
            </table>
          </ScrollX>

          {confirmations.declineReasons.length > 0 && (
            <p className="mt-3 text-caption text-muted">
              Of the declines that said why:{' '}
              {confirmations.declineReasons.map((r) => `${REASON_LABELS[r.reason] ?? r.reason} (${r.count})`).join(', ')}.
              Most declines say nothing, and that is the design — the portal asks without
              requiring an answer, and a texted &ldquo;no&rdquo; can never carry one.
            </p>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="mb-3 font-semibold">Completed sessions per week</h2>
          <ScrollX label="Completed sessions per week">
            <div className="flex min-w-[600px] items-end gap-1" style={{ height: 140 }}>
              {Object.entries(
                weeks.reduce<Record<string, number>>((acc, w) => {
                  acc[w.week] = (acc[w.week] ?? 0) + w.sessions;
                  return acc;
                }, {}),
              ).map(([week, sessions]) => (
                <div key={week} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <span className="font-mono text-nano text-subtle">{sessions}</span>
                  <div
                    className="w-full rounded-t"
                    style={{ height: `${(sessions / maxWeekly) * 110}px`, background: 'var(--accent)' }}
                    title={`Week of ${week}: ${sessions}`}
                  />
                  <span className="font-mono text-nano text-subtle">{week.slice(5)}</span>
                </div>
              ))}
            </div>
          </ScrollX>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 font-semibold">Where enquiries come from</h2>
          <p className="mb-3 max-w-prose text-caption text-subtle">
            Counted over calls, not over clients. A mix built from the client list shows
            which sources send people and hides which sources send people who go
            elsewhere &mdash; and those are the two halves of the same decision.
          </p>
          {referrals.totals.total === 0 ? (
            <p className="text-body text-muted">No enquiries were taken in this period.</p>
          ) : (
            <table className="w-full border-collapse text-body">
              <thead>
                <tr className="text-left text-muted">
                  <Th>Source</Th><Th right>Calls</Th><Th right>Converted</Th>
                  <Th right>Open</Th><Th right>Rate</Th>
                </tr>
              </thead>
              <tbody>
                {referrals.sources.map((s) => (
                  <tr key={s.source}>
                    <Td>{SOURCE_LABELS[s.source] ?? s.source}</Td>
                    <Td right>{s.total}</Td>
                    <Td right>{s.converted}</Td>
                    <Td right>{s.open}</Td>
                    <Td right>{pct(s.conversionRate)}</Td>
                  </tr>
                ))}
                <tr>
                  <Td><span className="font-medium">All sources</span></Td>
                  <Td right>{referrals.totals.total}</Td>
                  <Td right>{referrals.totals.converted}</Td>
                  <Td right>{referrals.totals.open}</Td>
                  <Td right>{pct(referrals.conversionRate)}</Td>
                </tr>
              </tbody>
            </table>
          )}
          {referrals.referrers.length > 0 && (
            <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              <h3 className="font-medium">Which practice, which doctor</h3>
              {/* The table the "GP" row could never be. A code answers how
                  many; only the entity answers which surgery has gone quiet,
                  and that is the one a practice manager rings. No client is
                  named here — a surgery is the practice's own business
                  relationship, not somebody's health. */}
              <p className="mt-1 mb-2 max-w-prose text-caption text-subtle">
                Only referrals where somebody wrote the surgery down. A blank is
                &ldquo;nobody recorded it&rdquo;, so it is absent rather than sitting at the
                top of this table as a referrer called Unknown.
              </p>
              <table className="w-full border-collapse text-body">
                <thead>
                  <tr className="text-left text-muted">
                    <Th>Referred by</Th><Th right>Calls</Th><Th right>Converted</Th><Th right>Rate</Th>
                  </tr>
                </thead>
                <tbody>
                  {referrals.referrers.map((r) => (
                    <tr key={r.id}>
                      <Td>{r.label}</Td>
                      <Td right>{r.total}</Td>
                      <Td right>{r.converted}</Td>
                      <Td right>{pct(r.conversionRate)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-caption text-subtle">
            {referrals.daysToConversion === null
              ? 'Nothing converted in this period, so there is no time to report.'
              : `Median ${referrals.daysToConversion.toFixed(1)} days from the call to a client record.`}
            {' '}The rate divides by every call taken, open ones included: a growing pile of
            unreturned calls should move this number, not hide behind it.
          </p>
        </Card>

        <Card>
          <h2 className="mb-1 font-semibold">Why enquiries ended</h2>
          <p className="mb-3 max-w-prose text-caption text-subtle">
            A fixed vocabulary, never free text. &ldquo;No capacity&rdquo; is a hiring
            question and &ldquo;went elsewhere&rdquo; is a waiting-time question; a
            notes field would have made them the same row.
          </p>
          {referrals.reasons.length === 0 ? (
            <p className="text-body text-muted">Nothing was discarded in this period.</p>
          ) : (
            <ul className="space-y-1.5 text-body">
              {referrals.reasons.map((r) => (
                <li key={r.reason} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 text-muted">{DISCARD_LABELS[r.reason] ?? r.reason}</span>
                  <span
                    className="h-2.5 rounded-full"
                    style={{
                      background: 'var(--accent)',
                      width: `${(r.count / referrals.reasons[0]!.count) * 60}%`,
                      minWidth: '4px',
                    }}
                  />
                  <span className="font-mono text-caption">{r.count}</span>
                </li>
              ))}
            </ul>
          )}

          {referrals.destinations.length > 0 && (
            <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              <h3 className="font-medium">Where they went instead</h3>
              {/* The other direction of the same directory. "Referred out" is
                  the one discard reason kept for a year rather than ninety
                  days, because it records the practice having acted — and until
                  there was a destination it could not say what the act was. */}
              <ul className="mt-2 space-y-1 text-body">
                {referrals.destinations.map((d) => (
                  <li key={d.id} className="flex items-baseline justify-between gap-2">
                    <span className="text-muted">{d.label}</span>
                    <span className="font-mono text-caption">{d.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-1 font-semibold">Notes nobody signed</h2>
          <p className="mb-3 max-w-prose text-caption text-subtle">
            Sessions whose clinician left before signing the note, by departure, whatever the
            dates above. Nobody else may sign them, so each is a permanent gap in a client&rsquo;s
            record &mdash; and this number is how the practice finds out whether showing a
            leaver their unsigned notes is working.
          </p>
          {abandoned.length === 0 ? (
            <p className="text-body text-muted">Nobody has left.</p>
          ) : (
            <ul className="space-y-1 text-body">
              {abandoned.map((d) => (
                <li key={d.id} className="flex items-baseline justify-between gap-2">
                  <span className="text-muted">{d.name}, last day {dayLabel(d.lastDayOn)}</span>
                  <span className="font-mono text-caption">{d.abandoned}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="mt-4 text-caption text-subtle">
        Counts and rates only. No client is named on this screen and no session content is
        reachable from it.
      </p>
    </>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  gp: 'GP or another clinician',
  friend: 'Friend or family',
  search: 'Found us online',
  other: 'Something else',
};

const DISCARD_LABELS: Record<string, string> = {
  no_answer: 'Called back, no answer',
  not_a_fit: 'Not a fit',
  referred_out: 'Referred out',
  no_capacity: 'No capacity',
  chose_elsewhere: 'Went elsewhere',
  duplicate: 'Duplicate call',
  spam: 'Not a real enquiry',
};

const REASON_LABELS: Record<string, string> = {
  cannot_make_it: 'cannot make that time',
  need_a_different_time: 'needs a different time',
  prefer_earlier: 'prefers earlier',
  prefer_later: 'prefers later',
};

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th className={`border-b py-1.5 font-medium${right ? ' text-right' : ''}`} style={{ borderColor: 'var(--border)' }}>
    {children}
  </th>
);

const Td = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <td className={`border-b py-1.5${right ? ' text-right font-mono' : ''}`} style={{ borderColor: 'var(--border)' }}>
    {children}
  </td>
);

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'danger' }) {
  return (
    <Card>
      <p className="text-micro font-medium tracking-wide text-subtle uppercase">{label}</p>
      <p className="mt-1 font-mono text-2xl" style={{ color: tone === 'danger' ? 'var(--danger)' : undefined }}>
        {value}
      </p>
    </Card>
  );
}

export default withDenial(ReportsPage, {
  title: 'Practice reporting',
  children:
    'Utilisation, no-shows and late cancellations are aggregate clinical operations. They belong to the practice manager.',
});
