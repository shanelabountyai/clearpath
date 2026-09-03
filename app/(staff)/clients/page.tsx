import Link from 'next/link';
import { listClients } from '../../../src/clients/repository';
import { requireSession } from '../../../src/session';
import { ownCaseloadOnly } from '../../../src/auth/permissions';
import { Badge, EmptyState, PageHeader, TierBanner, money } from '../../../src/ui/primitives';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { actor } = await requireSession();
  const { q } = await searchParams;
  const clients = await listClients(actor, { search: q?.trim() || undefined });

  return (
    <>
      <PageHeader
        title={ownCaseloadOnly(actor) ? 'My clients' : 'Clients'}
        subtitle={`${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`}
        actions={
          <form className="flex items-center gap-2">
            <label htmlFor="q" className="sr-only">Search clients</label>
            <input
              id="q" name="q" defaultValue={q ?? ''} placeholder="Name or code"
              className="rounded-[var(--radius)] border px-2.5 py-1.5 text-body"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
            />
            <button
              className="rounded-[var(--radius)] px-3 py-1.5 text-body font-medium"
              style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
            >
              Search
            </button>
          </form>
        }
      />

      <div className="mb-4">
        <TierBanner tier="operational" />
      </div>

      {clients.length === 0 ? (
        <EmptyState title="No clients match">Try a different name or code.</EmptyState>
      ) : (
        <div className="scroll-x rounded-[var(--radius-lg)] border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full min-w-[720px] border-collapse text-body">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                {['Client', 'Code', 'Treating clinician', 'Fee', 'Reminders', 'Status'].map((h) => (
                  <th key={h} className="border-b px-3 py-2 text-left font-medium text-muted" style={{ borderColor: 'var(--border)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="hover:bg-[var(--surface-sunken)]">
                  <td className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                    <Link href={`/clients/${c.id}`} className="font-medium text-accent hover:underline">
                      {c.lastName}, {c.firstName}
                    </Link>
                  </td>
                  <td className="border-b px-3 py-2 font-mono text-caption text-muted" style={{ borderColor: 'var(--border)' }}>{c.code}</td>
                  <td className="border-b px-3 py-2 text-muted" style={{ borderColor: 'var(--border)' }}>{c.treatingClinician.name}</td>
                  <td className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                    {c.feeCents === null ? <span className="text-subtle">Standard</span> : (
                      <Badge tone="info">{money(c.feeCents)} sliding</Badge>
                    )}
                  </td>
                  <td className="border-b px-3 py-2 text-muted" style={{ borderColor: 'var(--border)' }}>
                    {c.reminderPreference === 'none' ? <Badge tone="warning">None — do not message</Badge> : c.reminderPreference}
                  </td>
                  <td className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                    {c.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default withDenial(ClientsPage, {
  title: 'Client records',
  children:
    'The client list is clinical. It is visible to the people delivering or administering care, and the audit role is deliberately not one of them.',
});
