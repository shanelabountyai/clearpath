'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { SAVE_FAILURE_TEXT, type NoteSaveState } from '../notes/save-failure';

/**
 * The note textarea that does not lose what was typed (PRD 2).
 *
 * Nothing is saved that the clinician did not choose to save: no autosave, no
 * browser storage. The text lives in this component's state until a button is
 * pressed. A save that fails comes back as a code and the text stays in the box,
 * and leaving with unsaved changes asks first.
 *
 * `saved` is the server's copy. A successful save revalidates the page, the
 * prop catches up, and the form is clean again without any bookkeeping here.
 * The buttons are children, so each page keeps its own; they say what they do
 * through `name="intent"`, and the fieldset disables them while a save runs.
 */
export function NoteEditor({
  noteId,
  saved,
  rows,
  action,
  children,
}: {
  noteId: string;
  saved: string;
  rows: number;
  action: (prev: NoteSaveState, formData: FormData) => Promise<NoteSaveState>;
  children: React.ReactNode;
}) {
  const [text, setText] = useState(saved);
  const [state, dispatch, pending] = useActionState(action, null);
  const dirty = text !== saved;
  // A successful save returns null, the same as no save yet, so success is
  // read off the end of a save that came back without a failure (review D2).
  const [justSaved, setJustSaved] = useState(false);
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && !state) setJustSaved(true);
    wasPending.current = pending;
  }, [pending, state]);

  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => e.preventDefault();
    // In-app links never fire beforeunload, and the menu is the likeliest way
    // out. Capture on the document runs before React's own listener, so a
    // cancelled click never reaches Next's router.
    // ponytail: the browser's back button inside the app is not caught; that
    // needs a history guard entry, add it if back-navigation loses a note.
    const click = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href]');
      if (!link || link.getAttribute('target') === '_blank') return;
      if (!window.confirm('This note has changes that are not saved. Leave anyway?')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', click, true);
    };
  }, [dirty]);

  return (
    <form action={dispatch}>
      <input type="hidden" name="noteId" value={noteId} />
      <label htmlFor="content" className="sr-only">Note</label>
      <textarea
        id="content" name="content" rows={rows} value={text}
        onChange={(e) => { setText(e.target.value); setJustSaved(false); }}
        aria-describedby={state ? 'save-failure' : undefined}
        className="w-full rounded-[var(--radius)] border p-4 font-serif text-subhead leading-reading"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      />
      {state && (
        <p
          id="save-failure" role="alert"
          className="mt-2 rounded-[var(--radius)] border px-3 py-2 text-body"
          style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
        >
          {SAVE_FAILURE_TEXT[state.failure]}
        </p>
      )}
      <fieldset disabled={pending} className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
        {children}
        {dirty && !pending && <span className="text-caption text-muted">Unsaved changes</span>}
        <span role="status" className="text-caption text-muted">{justSaved && !dirty ? 'Saved' : ''}</span>
      </fieldset>
    </form>
  );
}
