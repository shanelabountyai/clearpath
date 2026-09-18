import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getGroupSession } from '../../../../src/scheduling/groups';
import { NotFound } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { minutesToHHMM, utcToZoned } from '../../../../src/time';
import { Card, PageHeader, StatusChip, TierBanner } from '../../../../src/ui/primitives';
import { cancelGroup } from '../actions';
import { ConfirmButton } from '@/src/ui/confirm-button';

export const dynamic = 'force-dynamic';

export default async function GroupSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSession();

  let group;
  try {
    group = await getGroupSession(id);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }

  const first = group.appointments[0];
  const when = first ? utcToZoned(first.startAt) : null;
  const live = group.appointments.filter(
    (a) => a.status !== 'cancelled' && a.status !== 'late_cancelled',
  );

  return (
    <>
      <PageHeader
        title={group.topic ?? 'Group session'}
        subtitle={when ? `${when.date} · ${minutesToHHMM(when.minutes)} · ${live.length} attending` : 'No attendees'}
        actions={
          live.length > 0 ? (
            <form action={cancelGroup}>
              <input type="hidden" name="groupId" value={group.id} />
              <ConfirmButton
                variant="danger"
                title={`Cancel this session for all ${live.length} attending?`}
                consequence="Every attendee's appointment is cancelled at once, not just one person's."
                confirmLabel="Cancel the session"
              >
                Cancel the session
              </ConfirmButton>
            </form>
          ) : undefined
        }
      />

      <div className="mx-auto max-w-2xl space-y-4">
        <TierBanner tier="operational">
          Roster and attendance. Each attendee keeps their own note, their own fee
          and their own record — a group is a shared hour, not a shared file.
        </TierBanner>

        <Card>
          <ul className="space-y-2 text-body">
            {group.appointments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <Link href={`/appointments/${a.id}`} className="text-accent hover:underline">
                  {a.client.firstName} {a.client.lastName}
                  <span className="ml-1.5 font-mono text-caption text-subtle">{a.client.code}</span>
                </Link>
                <StatusChip status={a.status} />
              </li>
            ))}
            {group.appointments.length === 0 && (
              <li className="text-muted">Everyone has been moved out of this session.</li>
            )}
          </ul>
        </Card>
      </div>
    </>
  );
}
