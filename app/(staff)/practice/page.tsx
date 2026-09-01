import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { guarded } from '../../../src/auth/guard';
import { Badge, Card, Field, PageHeader, money } from '../../../src/ui/primitives';
import { ROLE_LABEL } from '../../../src/ui/shell';

export const dynamic = 'force-dynamic';

export default async function PracticePage() {
  const { actor } = await requireSession();

  const data = await guarded(
    { actor, action: 'read', resource: 'user' },
    async (tx) => ({
      users: await tx.user.findMany({
        where: { role: { not: 'client' } },
        select: {
          id: true, name: true, email: true, role: true, active: true,
          supervisor: { select: { id: true, name: true } },
          supervisees: { select: { id: true, name: true } },
        },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      }),
      rooms: await tx.room.findMany({ orderBy: { name: 'asc' } }),
      settings: await tx.practiceSettings.findUnique({ where: { id: 1 } }),
    }),
  );

  const supervisors = data.users.filter((u) => u.supervisees.length > 0);

  return (
    <>
      <PageHeader title="Practice" subtitle="People, supervision, rooms and policy" />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 font-semibold">People</h2>
            <div className="scroll-x">
              <table className="w-full min-w-[520px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-muted">
                    {['Name', 'Role', 'Supervised by', 'Status'].map((h) => (
                      <th key={h} className="border-b py-2 font-medium" style={{ borderColor: 'var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td className="border-b py-2" style={{ borderColor: 'var(--border)' }}>
                        <span className="font-medium">{u.name}</span>
                        <span className="block text-[12px] text-subtle">{u.email}</span>
                      </td>
                      <td className="border-b py-2 text-muted" style={{ borderColor: 'var(--border)' }}>{ROLE_LABEL[u.role]}</td>
                      <td className="border-b py-2" style={{ borderColor: 'var(--border)' }}>
                        {u.supervisor ? u.supervisor.name : <span className="text-subtle">—</span>}
                      </td>
                      <td className="border-b py-2" style={{ borderColor: 'var(--border)' }}>
                        {u.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <h2 className="font-semibold">Supervision</h2>
            <p className="mt-1 mb-3 max-w-prose text-[13px] text-muted">
              These relationships are data, not code. Repointing one immediately reroutes
              both read access to progress notes and the co-signature queue — no deploy, no
              cache to clear.
            </p>
            {supervisors.length === 0 ? (
              <p className="text-[13px] text-muted">Nobody is currently supervising.</p>
            ) : (
              <ul className="space-y-3">
                {supervisors.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium">{s.name}</span>
                    <span aria-hidden className="text-subtle">→</span>
                    {s.supervisees.map((sv) => (
                      <Badge key={sv.id} tone="accent">{sv.name}</Badge>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[12px] text-subtle">
              A supervisor reads and co-signs their supervisees&rsquo; progress notes. They do not
              read anyone&rsquo;s process notes, supervisees included.
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 font-semibold">Rooms</h2>
            <ul className="space-y-1.5 text-[13px]">
              {data.rooms.map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span>{r.name}</span>
                  {r.active ? <Badge tone="success">In use</Badge> : <Badge>Out of use</Badge>}
                </li>
              ))}
            </ul>
          </Card>

          {data.settings && (
            <Card>
              <h2 className="mb-2 font-semibold">Policy</h2>
              <dl className="space-y-2.5">
                <Field label="Standard fee">{money(data.settings.standardFeeCents)}</Field>
                <Field label="Late-cancel window">{data.settings.lateCancelWindowHours} hours</Field>
                <Field label="Late-cancel fee">{money(data.settings.lateCancelFeeCents)}</Field>
                <Field label="Booking horizon">{data.settings.recurrenceHorizonDays} days</Field>
                <Field label="Continuity gap">{data.settings.continuityGapDays} days</Field>
                <Field label="Name used in messages">{data.settings.messagingName}</Field>
              </dl>
              <p className="mt-3 text-[12px] text-subtle">
                Messages to clients use &ldquo;{data.settings.messagingName}&rdquo;, not
                &ldquo;{data.settings.name}&rdquo;. A lock-screen preview should not say why
                somebody is coming in.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
