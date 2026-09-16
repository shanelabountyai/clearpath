import { coSignQueue } from '../../../src/notes/service';
import { requireSession } from '../../../src/session';
import { CoSignRow, Card, EmptyState, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { coSignNote } from '../notes/actions';

export const dynamic = 'force-dynamic';

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
            {queue.map((n) => <CoSignRow key={n.id} note={n} action={coSignNote} />)}
          </ul>
        </Card>
      )}
    </>
  );
}
