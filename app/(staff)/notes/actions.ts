'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '../../../src/session';
import {
  amendProcessNote, amendProgressNote, closeProcessNote, coSignProgressNote,
  signProgressNote, updateProcessNote, updateProgressNote,
} from '../../../src/notes/service';

export async function saveDraftNote(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('noteId'));
  await updateProgressNote(actor, id, String(formData.get('content') ?? ''));
  revalidatePath(`/notes/${id}`);
}

export async function signNote(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('noteId'));
  const content = formData.get('content');
  if (typeof content === 'string') await updateProgressNote(actor, id, content);
  await signProgressNote(actor, id);
  revalidatePath(`/notes/${id}`);
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

export async function saveProcessNote(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('noteId'));
  await updateProcessNote(actor, id, String(formData.get('content') ?? ''));
  revalidatePath(`/process-notes/${id}`);
}

export async function closeMyProcessNote(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('noteId'));
  await closeProcessNote(actor, id);
  revalidatePath(`/process-notes/${id}`);
}

export async function amendMyProcessNote(formData: FormData) {
  const { actor } = await requireSession();
  const id = String(formData.get('noteId'));
  const content = String(formData.get('content') ?? '').trim();
  if (content) await amendProcessNote(actor, id, content);
  revalidatePath(`/process-notes/${id}`);
}
