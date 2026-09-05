import { requireSession } from '../../../src/session';
import { confirmationReport, utilizationReport, weeklyVolume } from '../../../src/reports/utilization';
import { addDays, localDateOf } from '../../../src/time';
import { Badge, Card, PageHeader, money } from '../../../src/ui/primitives';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { actor } = await requireSession();
  const q = await searchParams;
  const to = q.to ?? localDateOf(systemClock.now());
  const from = q.from ?? addDays(to, -90);

  const [report, weeks, confirmation] = await Promise.all([
    utilizationReport(actor, { from, to }),
    weeklyVolume(actor, { from, to }),
    confirmationReport(actor, { from, to }),
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
          <div className="scroll-x">
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
          </div>
        </Card>

        {/* P1-4. What the confirmation policy did, in the place somebody
            deciding whether to keep it would look. The fee total is the column
            that matters: the argument against this policy is answerable only
            from data, and a number nobody can find is a number nobody checks. */}
        <Card className="lg:col-span-2">
          <h2 className="mb-1 font-semibold">Confirmation</h2>
          <p className="mb-3 max-w-prose text-caption text-muted">
            Rates are against the {confirmation.asked} sessions the practice was allowed
            to ask about. The {confirmation.totals.notRequired} it was not — clients on
            &ldquo;no messages&rdquo;, or booked too late to ask — can never be charged
            under this policy, and are counted here rather than hidden.
          </p>

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Confirmed" value={pct(confirmation.rates.confirmed)} />
            <Stat label="Declined" value={pct(confirmation.rates.declined)} />
            <Stat
              label="No reply"
              value={pct(confirmation.rates.noResponse)}
              tone={confirmation.rates.noResponse > 0.25 ? 'danger' : undefined}
            />
            <Stat
              label="Charged for silence"
              value={`${confirmation.totals.charged} · ${money(confirmation.totals.feeCents)}`}
              tone={confirmation.rates.charged > 0.05 ? 'danger' : undefined}
            />
          </div>

          {confirmation.totals.waived > 0 && (
            <p className="mb-3 text-caption text-muted">
              <Badge tone="info" glyph="↩">{confirmation.totals.waived} waived</Badge>{' '}
              — charges the practice reversed, excluded from the total above.
            </p>
          )}

          <div className="scroll-x">
            <table className="w-full min-w-[520px] border-collapse text-body">
              <thead>
                <tr className="text-left text-muted">
                  <th className="border-b py-1.5 font-medium" style={{ borderColor: 'var(--border)' }}>Clinician</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>Confirmed</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>Declined</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>No reply</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>Not asked</th>
                  <th className="border-b py-1.5 text-right font-medium" style={{ borderColor: 'var(--border)' }}>Charged</th>
                </tr>
              </thead>
              <tbody>
                {confirmation.byClinician.map((c) => (
                  <tr key={c.id}>
                    <td className="border-b py-1.5" style={{ borderColor: 'var(--border)' }}>{c.name}</td>
                    <td className="border-b py-1.5 text-right font-mono" style={{ borderColor: 'var(--border)' }}>{c.confirmed}</td>
                    <td className="border-b py-1.5 text-right font-mono" style={{ borderColor: 'var(--border)' }}>{c.declined}</td>
                    <td className="border-b py-1.5 text-right font-mono" style={{ borderColor: 'var(--border)' }}>{c.noResponse}</td>
                    <td className="border-b py-1.5 text-right font-mono text-subtle" style={{ borderColor: 'var(--border)' }}>{c.notRequired}</td>
                    <td className="border-b py-1.5 text-right font-mono" style={{ borderColor: 'var(--border)' }}>
                      {c.charged ? `${c.charged} · ${money(c.feeCents)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="mb-3 font-semibold">Completed sessions per week</h2>
          <div className="scroll-x">
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
          </div>
        </Card>
      </div>

      <p className="mt-4 text-caption text-subtle">
        Counts and rates only. No client is named on this screen and no session content is
        reachable from it.
      </p>
    </>
  );
}

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
