import Link from 'next/link';
import { getProcessNote } from '../../../../src/notes/service';
import { Forbidden, NotFound } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { localDateOf } from '../../../../src/time';
import { Badge, Card, LockedPanel, PageHeader, TierBanner } from '../../../../src/ui/primitives';
import { NoteEditor } from '../../../../src/ui/note-editor';
import { AmendForm } from '../../../../src/ui/amend-form';
import { amendMyProcessNote, saveProcessNoteText } from '../../notes/actions';
import { Button } from '@/src/ui/primitives';

export const dynamic = 'force-dynamic';

export default async function ProcessNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireSession();

  let note;
  try {
    note = await getProcessNote(actor, id);
  } catch (e) {
    // A denial here is the designed state, not an error. There is deliberately
    // no break-glass prompt: this is the one door with nothing behind the lock
    // for anyone but its author.
    if (e instanceof Forbidden || e instanceof NotFound) {
      return (
        <div className="mx-auto max-w-2xl py-8">
          <LockedPanel title="This process note is not yours" />
        </div>
      );
    }
    throw e;
  }

  return (
    <>
      <PageHeader
        title="Process note"
        subtitle={
          <>
            <Link href={`/clients/${note.clientId}`} className="text-accent hover:underline">client record</Link>
            {' '}· {localDateOf(note.createdAt)}
          </>
        }
        actions={note.closedAt ? <Badge>Closed</Badge> : <Badge tone="accent">Open</Badge>}
      />

      <div className="mb-4">
        <TierBanner tier="private" />
      </div>

      <div className="mx-auto max-w-3xl space-y-4">
        <Card>
          {/* See the progress note page: announces closing (review D2). */}
          <p role="status" className="sr-only">{note.closedAt ? 'This note is closed.' : ''}</p>
          {note.closedAt ? (
            <article className="font-serif text-subhead leading-reading whitespace-pre-wrap">{note.content}</article>
          ) : (
            <NoteEditor noteId={note.id} saved={note.content} rows={14} action={saveProcessNoteText}>
              <Button variant="quiet" name="intent" value="save">
                Save
              </Button>
              <Button variant="private" name="intent" value="close">
                Close note
              </Button>
              <span className="text-caption text-subtle">Closing saves and freezes it; later thoughts append.</span>
            </NoteEditor>
          )}
        </Card>

        {note.amendments.length > 0 && (
          <Card>
            <h2 className="mb-3 font-semibold">Later thoughts</h2>
            <ol className="space-y-3">
              {note.amendments.map((a) => (
                <li key={a.id} className="border-l-2 pl-3" style={{ borderColor: 'var(--tier-private)' }}>
                  <p className="text-caption text-subtle">{localDateOf(a.createdAt)}</p>
                  <p className="mt-0.5 font-serif text-subhead leading-reading whitespace-pre-wrap">{a.content}</p>
                </li>
              ))}
            </ol>
          </Card>
        )}

        {note.closedAt && (
          <Card>
            <AmendForm
              noteId={note.id} action={amendMyProcessNote} label="Add a later thought" labelClassName="block font-semibold" submit="Append"
              textareaClassName="mt-2 w-full rounded-[var(--radius)] border p-2.5 font-serif text-lead"
            />
          </Card>
        )}
      </div>
    </>
  );
}
