'use client';

import { useActionState, useEffect, useState } from 'react';
import { SAVE_FAILURE_TEXT, type NoteSaveState } from '../notes/save-failure';
import { useLeaveGuard } from './leave-guard';

/**
 * The amendment / later-thought form (§54). Same promise as `NoteEditor`: a
 * save that does not land leaves the text in the box under a sentence saying
 * why, and leaving with text typed asks first. Unlike the editor there is no
 * server copy to compare with, so a save that comes back clean clears the box.
 */
export function AmendForm({
  noteId, action, label, labelClassName, submit, rows = 3, textareaClassName, children,
}: {
  noteId: string;
  action: (prev: NoteSaveState, formData: FormData) => Promise<NoteSaveState>;
  label: string;
  labelClassName: string;
  submit: string;
  rows?: number;
  textareaClassName: string;
  children?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [state, dispatch, pending] = useActionState(action, null);
  useLeaveGuard(text.trim() !== '', 'This text has not been added. Leave anyway?');
  // React 19 resets the form after an action; clear the controlled text only on success.
  useEffect(() => { if (!pending && !state) setText(''); }, [pending, state]);

  return (
    <form action={dispatch}>
      <input type="hidden" name="noteId" value={noteId} />
      <label htmlFor="amend" className={labelClassName}>{label}</label>
      {children}
      <textarea
        id="amend" name="content" rows={rows} required value={text}
        onChange={(e) => setText(e.target.value)}
        aria-describedby={state ? 'amend-failure' : undefined}
        className={textareaClassName}
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      />
      {state && (
        <p
          id="amend-failure" role="alert"
          className="mt-2 rounded-[var(--radius)] border px-3 py-2 text-body"
          style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
        >
          {SAVE_FAILURE_TEXT[state.failure]}
        </p>
      )}
      <button disabled={pending} className="mt-2 rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium" style={{ borderColor: 'var(--border-strong)' }}>
        {submit}
      </button>
    </form>
  );
}
