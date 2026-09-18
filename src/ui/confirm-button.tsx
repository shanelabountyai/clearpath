'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { Button, type ButtonVariant } from './button';

/**
 * A submit button that asks first (PRD 5). The first click opens a native
 * `<dialog>` that states the consequence, and only the button inside it
 * submits. The dialog sits inside the caller's form, so that button submits
 * the same server action, with the same fields, and the server still makes
 * every permission decision.
 *
 * The trigger is `type="button"`, so without JavaScript the action fails
 * closed: nothing is submitted unconfirmed. The form is validated before the
 * dialog opens, so a missing field is reported on the form, not after the
 * confirm.
 *
 * `subject` names the select that says who or what is affected, so the dialog
 * repeats the choice back ("Who is leaving: Beth") before it is recorded.
 */
export function ConfirmButton({
  children, title, consequence, confirmLabel, variant = 'solid', name, value, subject, className, style,
}: {
  children: ReactNode;
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  variant?: ButtonVariant;
  name?: string;
  value?: string;
  subject?: { field: string; label: string };
  className?: string;
  style?: React.CSSProperties;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [chosen, setChosen] = useState('');

  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    const form = e.currentTarget.form;
    if (form && !form.reportValidity()) return;
    const el = subject && form?.elements.namedItem(subject.field);
    setChosen(el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.text ?? '') : '');
    dialog.current?.showModal();
  };

  return (
    <>
      <Button type="button" variant={variant} onClick={open} className={className} style={style}>
        {children}
      </Button>
      <dialog
        ref={dialog} aria-labelledby={titleId}
        className="m-auto w-[min(28rem,calc(100vw-32px))] rounded-[var(--radius-lg)] border p-5 text-left whitespace-normal"
        style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-raised)', color: 'var(--text)' }}
      >
        <h2 id={titleId} className="font-semibold">{title}</h2>
        {subject && chosen && (
          <p className="mt-2 text-body">
            <span className="text-muted">{subject.label}:</span> <strong>{chosen}</strong>
          </p>
        )}
        <div className="mt-2 text-body text-muted">{consequence}</div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {/* First, so it is where focus lands: Enter on open does nothing harmful. */}
          <Button type="button" variant="quiet" onClick={() => dialog.current?.close()}>Go back</Button>
          <Button type="submit" variant={variant} name={name} value={value} onClick={() => dialog.current?.close()}>
            {confirmLabel}
          </Button>
        </div>
      </dialog>
    </>
  );
}
