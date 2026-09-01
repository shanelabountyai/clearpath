import Link from 'next/link';
import { coSignQueue } from '../../../src/notes/service';
import { requireSession } from '../../../src/session';
import { localDateOf } from '../../../src/time';
import { Badge, Card, EmptyState, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { coSignNote } from '../notes/actions';

export const dynamic = 'force-dynamic';

/**
 * Ageing escalates, but not at day two. An unsigned supervisee note is a
 * compliance clock, and a queue that shouts on the first day teaches people to
 * ignore it.
 */
function ageTone(days: number) {
  if (days >= 14) return { tone: 'danger' as const, label: `${days} days` };
  if (days >= 7) return { tone: 'warning' as const, label: `${days} days` };
  return { tone: 'neutral' as const, label: days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}` };
}

export default async function CoSignPage() {
  const { actor } = await requireSession();
  const queue = await coSignQueue(actor);

  return (
    <>
      <PageHeader
        title="Co-signature queue"
        subtitle={`${queue.length} ${queue.length === 1 ? 'note' : 'notes'} from your supervisees`}
      />

      <div className="mb-4">
        <TierBanner tier="clinical">
          Progress notes written under your supervision. Their process notes are not here,
          and there is no view in which they would be.
        </TierBanner>
      </div>

      {queue.length === 0 ? (
        <EmptyState title="Nothing waiting">
          Every supervisee note that has been signed is also countersigned.
        </EmptyState>
      ) : (
        <Card className="p-0">
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {queue.map((n) => {
              const age = ageTone(n.waitingDays);
              return (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <Link href={`/notes/${n.id}`} className="font-medium text-accent hover:underline">
                      {n.client.lastName}, {n.client.firstName}
                    </Link>
                    <p className="text-[12.5px] text-muted">
                      <span className="font-mono">{n.client.code}</span> · {n.author.name} ·
                      session {n.appointment ? localDateOf(n.appointment.startAt) : '—'} ·
                      signed {n.signedAt ? localDateOf(n.signedAt) : '—'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={age.tone}>waiting {age.label}</Badge>
                    <form action={coSignNote}>
                      <input type="hidden" name="noteId" value={n.id} />
                      <input type="hidden" name="returnTo" value="queue" />
                      <button
                        className="rounded-[var(--radius)] px-3 py-1.5 text-[12.5px] font-medium"
                        style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                      >
                        Co-sign
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
