import { Conflict, Forbidden, NotFound } from '../errors';

/**
 * Why a note save did not land (PRD 2). The form keeps the clinician's text
 * whatever the reason, so this only chooses the sentence that sits above it.
 *
 * A code, never the error: a thrown message can say anything, and whatever
 * it says would cross to the browser (hard rule 3).
 */
export type SaveFailure = 'signed-out' | 'denied' | 'conflict' | 'failed';
export type NoteSaveState = { failure: SaveFailure } | null;

export function saveFailureOf(e: unknown): SaveFailure {
  if (e instanceof Forbidden || e instanceof NotFound) return 'denied';
  if (e instanceof Conflict) return 'conflict';
  return 'failed';
}

export const SAVE_FAILURE_TEXT: Record<SaveFailure, string> = {
  'signed-out':
    'Nothing was saved: nobody is signed in on this browser any more. Your text is still here. Choose your name again in another tab, then come back and press the button again.',
  denied:
    'Nothing was saved: the person now signed in on this browser cannot change this note. Your text is still here. Check who is signed in, in another tab, then try again.',
  conflict:
    'Nothing was saved: this note changed since the page loaded, and may already be signed or closed. Your text is still here. Copy what you need before reloading.',
  failed:
    'Nothing was saved because something went wrong on our side. Your text is still here. Try again in a moment.',
};
