'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Actor } from '../../../src/auth/permissions';
import { saveFailureOf, type NoteSaveState } from '../../../src/notes/save-failure';
import { currentSession, requireSession } from '../../../src/session';
import {
  amendProcessNote, amendProgressNote, closeProcessNote, coSignProgressNote,
  signProgressNote, updateProcessNote, updateProgressNote,
} from '../../../src/notes/service';

/**
 * Saves the note editor's text (PRD 2). Every failure returns a code instead of
 * throwing or redirecting, because either one unmounts the form and the text
 * with it. That includes a missing session: `requireSession` would redirect.
 */
async function keepingText(
  formData: FormData,
  save: (actor: Actor, id: string, content: string) => Promise<void>,
): Promise<NoteSaveState> {
  const session = await currentSession();
  if (!session) return { failure: 'signed-out' };
  const id = String(formData.get('noteId'));
  try {
    await save(session.actor, id, String(formData.get('content') ?? ''));
    return null;
  } catch (e) {
    const failure = saveFailureOf(e);
    // The name only: an unrecognised message may quote the note (hard rule 3).
    if (failure === 'failed') console.error('note save failed', id, e instanceof Error ? e.name : typeof e);
    return { failure };
  }
}

/** Save draft, or Sign. Sign saves the text first, as it always has. */
export async function saveProgressNoteText(_: NoteSaveState, formData: FormData) {
  return keepingText(formData, async (actor, id, content) => {
    await updateProgressNote(actor, id, content);
    if (formData.get('intent') === 'sign') await signProgressNote(actor, id);
    revalidatePath(`/notes/${id}`);
  });
}

export async function coSignNote(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('noteId'));
  await coSignProgressNote(actor, id);
  revalidatePath(`/notes/${id}`);
  revalidatePath('/cosign');
  if (formData.get('returnTo') === 'queue') redirect('/cosign');
}

export async function amendNote(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('noteId'));
  const content = String(formData.get('content') ?? '').trim();
  if (content) await amendProgressNote(actor, id, content);
  revalidatePath(`/notes/${id}`);
}

/**
 * Save, or Close note. Close saves the text first: before PRD 2 it did not,
 * so edits typed since the last Save vanished when the note was closed.
 */
export async function saveProcessNoteText(_: NoteSaveState, formData: FormData) {
  return keepingText(formData, async (actor, id, content) => {
    await updateProcessNote(actor, id, content);
    if (formData.get('intent') === 'close') await closeProcessNote(actor, id);
    revalidatePath(`/process-notes/${id}`);
  });
}

export async function amendMyProcessNote(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('noteId'));
  const content = String(formData.get('content') ?? '').trim();
  if (content) await amendProcessNote(actor, id, content);
  revalidatePath(`/process-notes/${id}`);
}
