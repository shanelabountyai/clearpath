import Link from 'next/link';
import { listClients } from '../../../src/clients/repository';
import { requireSession } from '../../../src/session';
import { ownCaseloadOnly } from '../../../src/auth/permissions';
import { Badge, PageHeader, TierBanner, money } from '../../../src/ui/primitives';
import { ClientSearch } from '../../../src/ui/client-search';
import { withDenial } from '@/src/ui/denied';
import { dayLabel } from '../departures/ui';

export const dynamic = 'force-dynamic';

async function ClientsPage() {
  const { actor } = await requireSession();
  const clients = await listClients(actor);

  return (
    <>
      <PageHeader
        title={ownCaseloadOnly(actor) ? 'My clients' : 'Clients'}
        subtitle={`${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`}
      />

      <div className="mb-4">
        <TierBanner tier="operational" />
      </div>

      <ClientSearch
        head={
          <thead>
            <tr style={{ background: 'var(--surface-sunken)' }}>
              {['Client', 'Code', 'Treating clinician', 'Fee', 'Reminders', 'Status'].map((h) => (
                <th key={h} className="border-b px-3 py-2 text-left font-medium text-muted" style={{ borderColor: 'var(--border)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        }
        rows={clients.map((c) => ({
          text: `${c.firstName} ${c.lastName} ${c.code}`,
          row: (
            <tr key={c.id} className="hover:bg-[var(--surface-sunken)]">
              <td className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                <Link href={`/clients/${c.id}`} className="font-medium text-accent hover:underline">
                  {c.lastName}, {c.firstName}
                </Link>
              </td>
              <td className="border-b px-3 py-2 font-mono text-caption text-muted" style={{ borderColor: 'var(--border)' }}>{c.code}</td>
              <td className="border-b px-3 py-2 text-muted" style={{ borderColor: 'var(--border)' }}>
                {c.treatingClinician.name}
                {c.coveringUntil && (
                  <span className="ml-1.5"><Badge tone="accent">you cover until {dayLabel(c.coveringUntil)}</Badge></span>
                )}
              </td>
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
          ),
        }))}
      />
    </>
  );
}

export default withDenial(ClientsPage, {
  title: 'Client records',
  children:
    'The client list is clinical. It is visible to the people delivering or administering care, and the audit role is deliberately not one of them.',
});
