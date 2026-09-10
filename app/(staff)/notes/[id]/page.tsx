import Link from 'next/link';
import { getProgressNote } from '../../../../src/notes/service';
import { may } from '../../../../src/auth/guard';
import { Forbidden } from '../../../../src/errors';
import { requireSession } from '../../../../src/session';
import { localDateOf } from '../../../../src/time';
import { Badge, Card, PageHeader, TierBanner } from '../../../../src/ui/primitives';
import { BreakGlassPrompt } from '../../break-glass';
import { amendNote, coSignNote, saveDraftNote, signNote } from '../actions';

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
  const canCoSign = may({
    actor, action: 'cosign', resource: 'progress_note',
    target: { authorId: note.authorId, authorSupervisorId: author.supervisorId ?? undefined },
  });

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
              <form action={signNote}>
                <input type="hidden" name="noteId" value={note.id} />
                <label htmlFor="content" className="sr-only">Note</label>
                <textarea
                  id="content" name="content" rows={16} defaultValue={note.content}
                  className="w-full rounded-[var(--radius)] border p-4 font-serif text-subhead leading-reading"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    formAction={saveDraftNote}
                    className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                    style={{ borderColor: 'var(--border-strong)' }}
                  >
                    Save draft
                  </button>
                  <button
                    className="rounded-[var(--radius)] px-3 py-1.5 text-body font-medium"
                    style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                  >
                    Sign
                  </button>
                  <span className="text-caption text-subtle">
                    Signing freezes the text. Corrections after that append as amendments.
                  </span>
                </div>
              </form>
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
                <button
                  className="w-full rounded-[var(--radius)] px-3 py-2 text-body font-medium"
                  style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                >
                  Co-sign this note
                </button>
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
