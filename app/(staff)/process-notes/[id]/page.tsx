import Link from 'next/link';
import { getProcessNote } from '../../../../src/notes/service';
import { Forbidden, NotFound } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { localDateOf } from '../../../../src/time';
import { Badge, Card, LockedPanel, PageHeader, TierBanner } from '../../../../src/ui/primitives';
import { amendMyProcessNote, closeMyProcessNote, saveProcessNote } from '../../notes/actions';

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
          {note.closedAt ? (
            <article className="font-serif text-[15px] leading-[1.75] whitespace-pre-wrap">{note.content}</article>
          ) : (
            <form action={saveProcessNote}>
              <input type="hidden" name="noteId" value={note.id} />
              <label htmlFor="content" className="sr-only">Note</label>
              <textarea
                id="content" name="content" rows={14} defaultValue={note.content}
                className="w-full rounded-[var(--radius)] border p-4 font-serif text-[15px] leading-[1.7]"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              />
              <div className="mt-3 flex items-center gap-2">
                <button className="rounded-[var(--radius)] border px-3 py-1.5 text-[13px] font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                  Save
                </button>
                <button
                  formAction={closeMyProcessNote}
                  className="rounded-[var(--radius)] px-3 py-1.5 text-[13px] font-medium"
                  style={{ background: 'var(--tier-private)', color: '#fff' }}
                >
                  Close note
                </button>
                <span className="text-[12px] text-subtle">Closing freezes it; later thoughts append.</span>
              </div>
            </form>
          )}
        </Card>

        {note.amendments.length > 0 && (
          <Card>
            <h2 className="mb-3 font-semibold">Later thoughts</h2>
            <ol className="space-y-3">
              {note.amendments.map((a) => (
                <li key={a.id} className="border-l-2 pl-3" style={{ borderColor: 'var(--tier-private)' }}>
                  <p className="text-[12px] text-subtle">{localDateOf(a.createdAt)}</p>
                  <p className="mt-0.5 font-serif text-[14.5px] leading-relaxed whitespace-pre-wrap">{a.content}</p>
                </li>
              ))}
            </ol>
          </Card>
        )}

        {note.closedAt && (
          <Card>
            <form action={amendMyProcessNote}>
              <input type="hidden" name="noteId" value={note.id} />
              <label htmlFor="amend" className="block font-semibold">Add a later thought</label>
              <textarea
                id="amend" name="content" rows={3} required
                className="mt-2 w-full rounded-[var(--radius)] border p-2.5 font-serif text-[14px]"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              />
              <button className="mt-2 rounded-[var(--radius)] border px-3 py-1.5 text-[13px] font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                Append
              </button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
