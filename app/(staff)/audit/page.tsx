import { queryAuditLog } from '../../../src/reports/audit';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { AuditRow, Card, EmptyState, PageHeader, ScrollX } from '../../../src/ui/primitives';
import { ROLE_LABEL } from '../../../src/ui/shell';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; actorId?: string; resource?: string; flagged?: string; denied?: string; reason?: string; cursor?: string }>;
}) {
  const { actor } = await requireSession();
  const q = await searchParams;

  const result = await queryAuditLog(actor, {
    clientId: q.clientId || undefined,
    actorId: q.actorId || undefined,
    resource: q.resource || undefined,
    flaggedOnly: q.flagged === '1',
    deniedOnly: q.denied === '1',
    reason: q.reason || undefined,
    cursor: q.cursor,
    limit: 120,
  });

  // Names for ids, resolved for display only. The log itself stores ids.
  const [users, clients] = await Promise.all([
    prisma.user.findMany({ select: { id: true, name: true } }),
    prisma.client.findMany({ select: { id: true, code: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const clientCode = new Map(clients.map((c) => [c.id, c.code]));

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle={`${result.total} events${q.clientId ? ' for this client' : ''}`}
        actions={
          <a
            href={`/audit/export?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()}`}
            className="rounded-[var(--radius)] border px-3 py-1.5 text-caption font-medium"
            style={{ borderColor: 'var(--border-strong)' }}
          >
            Export CSV
          </a>
        }
      />

      <Card className="mb-4">
        <form className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="clientId" className="block text-micro font-medium tracking-wide text-subtle uppercase">Client</label>
            <select id="clientId" name="clientId" defaultValue={q.clientId ?? ''} className="mt-1 rounded-[var(--radius)] border px-2 py-1.5 text-body" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}>
              <option value="">Any</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="actorId" className="block text-micro font-medium tracking-wide text-subtle uppercase">Person</label>
            <select id="actorId" name="actorId" defaultValue={q.actorId ?? ''} className="mt-1 rounded-[var(--radius)] border px-2 py-1.5 text-body" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}>
              <option value="">Anyone</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="resource" className="block text-micro font-medium tracking-wide text-subtle uppercase">Resource</label>
            <select id="resource" name="resource" defaultValue={q.resource ?? ''} className="mt-1 rounded-[var(--radius)] border px-2 py-1.5 text-body" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}>
              <option value="">Any</option>
              {['client', 'appointment', 'progress_note', 'process_note', 'form_submission', 'form_request', 'alert', 'attendance_history', 'fee'].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="reason" className="block text-micro font-medium tracking-wide text-subtle uppercase">Reason code</label>
            <input id="reason" name="reason" defaultValue={q.reason ?? ''} placeholder="leave:…" className="mt-1 rounded-[var(--radius)] border px-2 py-1.5 font-mono text-body" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }} />
          </div>
          <label className="flex items-center gap-1.5 text-body">
            <input type="checkbox" name="flagged" value="1" defaultChecked={q.flagged === '1'} /> Break-glass only
          </label>
          <label className="flex items-center gap-1.5 text-body">
            <input type="checkbox" name="denied" value="1" defaultChecked={q.denied === '1'} /> Denials only
          </label>
          <button className="rounded-[var(--radius)] px-3 py-1.5 text-body font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
            Filter
          </button>
        </form>
      </Card>

      {result.rows.length === 0 ? (
        <EmptyState title="No events match" />
      ) : (
        <ScrollX label="Audit events" className="rounded-[var(--radius-lg)] border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full min-w-[900px] border-collapse text-caption">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                {['When', 'Who', 'Role', 'Action', 'Resource', 'Client', 'Outcome', 'Reason'].map((h) => (
                  <th key={h} className="border-b px-3 py-2 text-left font-medium text-muted" style={{ borderColor: 'var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <AuditRow
                  key={r.id}
                  row={r}
                  actorLabel={userName.get(r.actorId) ?? <span className="font-mono text-subtle">{clientCode.get(r.actorId) ?? r.actorId.slice(0, 8)}</span>}
                  roleLabel={ROLE_LABEL[r.actorRole] ?? r.actorRole}
                  clientLabel={r.clientId ? clientCode.get(r.clientId) ?? '—' : '—'}
                />
              ))}
            </tbody>
          </table>
        </ScrollX>
      )}

      <p className="mt-3 text-caption text-subtle">
        Rows are append-only: the database refuses UPDATE and DELETE on this table. Ids only —
        no names, no note content, no answers. The names above are resolved for display.
      </p>
    </>
  );
}

export default withDenial(AuditPage, {
  title: 'The audit log is the auditor’s',
  children:
    'Who read what, and who was refused, is reviewed by someone who cannot open the records themselves. That separation is the point of the log, so it is not readable from inside the practice.',
});
