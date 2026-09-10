-- P0-4b: the status a draft takes when its author left before signing it.
--
-- Alone in its own migration on purpose. Postgres permits `ADD VALUE` inside a
-- transaction but forbids *using* the new value in the same one, and the next
-- migration's `progress_note_abandonment_has_a_cause` CHECK is exactly that
-- use. Two migrations is the documented shape of this, not a stylistic choice.
ALTER TYPE "ProgressNoteStatus" ADD VALUE 'abandoned';
