import Link from 'next/link';
import { getProgressNote, mayCoSign } from '../../../../src/notes/service';
import { Forbidden } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { localDateOf } from '../../../../src/time';
import { Badge, Card, PageHeader, TierBanner } from '../../../../src/ui/primitives';
import { BreakGlassPrompt } from '../../break-glass';
import { NoteEditor } from '../../../../src/ui/note-editor';
import { ConfirmButton } from '../../../../src/ui/confirm-button';
import { amendNote, coSignNote, saveProgressNoteText } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireSession();

  let note;
  try {
    note = await getProgressNote(actor, id);
  } catch (e) {
    if (e instanceof Forbidden) return <BreakGlassPrompt resource="this progress note" />;
    throw e;
  }

  const author = { supervisorId: note.author.supervisorId };
  const isAuthor = note.authorId === actor.id;
  // The co-signature's own target, so the cover for an away supervisor sees the button (leave D-21).
  const canCoSign = await mayCoSign(actor, id);

  return (
    <>
      <PageHeader
        title="Progress note"
        subtitle={
          <>
            <Link href={`/clients/${note.clientId}`} className="text-accent hover:underline">
              client record
            </Link>{' '}
            · {note.author.name} · {note.appointment ? localDateOf(note.appointment.startAt) : localDateOf(note.createdAt)}
          </>
        }
        actions={
          note.status === 'draft' ? <Badge tone="warning">Draft</Badge>
            : note.status === 'signed' ? <Badge tone="info" glyph="✍">Pending co-signature</Badge>
            : note.status === 'abandoned' ? <Badge tone="danger" glyph="⊘">Unsigned — author departed</Badge>
            : <Badge tone="success" glyph="✓">Co-signed</Badge>
        }
      />

      <div className="mb-4">
        <TierBanner tier="clinical" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <Card>
            {note.status === 'draft' && isAuthor ? (
              <NoteEditor noteId={note.id} saved={note.content} rows={16} action={saveProgressNoteText}>
                <button
                  name="intent" value="draft"
                  className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                  style={{ borderColor: 'var(--border-strong)' }}
                >
                  Save draft
                </button>
                <ConfirmButton
                  name="intent" value="sign"
                  title="Sign this note?"
                  consequence="Signing saves the text as it is now and freezes it. It is a legal record from this moment. Corrections after that append as amendments."
                  confirmLabel="Sign"
                >
                  Sign
                </ConfirmButton>
                <span className="text-caption text-subtle">
                  Signing freezes the text. Corrections after that append as amendments.
                </span>
              </NoteEditor>
            ) : (
              <article className="font-serif text-subhead leading-reading whitespace-pre-wrap">
                {note.content || <span className="text-subtle">This note is empty.</span>}
              </article>
            )}
          </Card>

          {note.amendments.length > 0 && (
            <Card>
              <h2 className="mb-3 font-semibold">Amendments</h2>
              <ol className="space-y-3">
                {note.amendments.map((a) => (
                  <li key={a.id} className="border-l-2 pl-3" style={{ borderColor: 'var(--border-strong)' }}>
                    <p className="text-caption text-subtle">
                      {a.author.name} · {localDateOf(a.createdAt)}
                    </p>
                    <p className="mt-0.5 font-serif text-subhead leading-reading whitespace-pre-wrap">{a.content}</p>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {note.status !== 'draft' && isAuthor && (
            <Card>
              <h2 className="font-semibold">Amend</h2>
              <p className="mt-1 text-body text-muted">
                The signed text stays exactly as signed. An amendment appends beneath it.
              </p>
              <form action={amendNote} className="mt-2">
                <input type="hidden" name="noteId" value={note.id} />
                <label htmlFor="amend" className="sr-only">Amendment</label>
                <textarea
                  id="amend" name="content" rows={3} required
                  className="w-full rounded-[var(--radius)] border p-2.5 font-serif text-lead"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                />
                <button className="mt-2 rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                  Add amendment
                </button>
              </form>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 font-semibold">Signatures</h2>
            <ul className="space-y-2 text-body">
              <li className="flex items-center justify-between gap-2">
                <span>{note.author.name}</span>
                {note.signedAt ? <Badge tone="success" glyph="✓">{localDateOf(note.signedAt)}</Badge> : <Badge>unsigned</Badge>}
              </li>
              {(note.status !== 'draft' && author.supervisorId) && (
                <li className="flex items-center justify-between gap-2">
                  <span>{note.coSignedBy?.name ?? 'Supervisor'}</span>
                  {note.coSignedAt
                    ? <Badge tone="success" glyph="✓">{localDateOf(note.coSignedAt)}</Badge>
                    : <Badge tone="info">awaiting</Badge>}
                </li>
              )}
            </ul>
            {note.status === 'signed' && author.supervisorId && (
              <p className="mt-3 text-caption text-muted">
                This note was written under supervision, so the record is not complete until
                the supervisor countersigns it.
              </p>
            )}
            {canCoSign && note.status === 'signed' && (
              <form action={coSignNote} className="mt-3">
                <input type="hidden" name="noteId" value={note.id} />
                <ConfirmButton
                  className="w-full py-2"
                  title="Co-sign this note?"
                  consequence="Your countersignature completes the record, and it cannot be withdrawn."
                  confirmLabel="Co-sign"
                >
                  Co-sign this note
                </ConfirmButton>
              </form>
            )}
          </Card>

          <Card>
            <h2 className="mb-1 font-semibold">Process notes</h2>
            <p className="text-caption text-muted">
              The author&rsquo;s private working notes for this client are a separate record with
              a separate rule: author only, with no override. They are not linked from here
              for anyone else.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
