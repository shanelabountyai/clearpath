-- Review #1: the append-only triggers are FOR EACH ROW on UPDATE/DELETE, and
-- TRUNCATE fires neither, so one statement (or a TRUNCATE ... CASCADE of a
-- table NoteAmendment references) could empty the history. A statement-level
-- BEFORE TRUNCATE trigger closes that. The same honest limitation applies: a
-- role that owns the table can DISABLE the trigger, which is exactly what
-- resetDb does for a local test/seed database, inside its own transaction.
CREATE TRIGGER "audit_event_no_truncate" BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_append_only"();

CREATE TRIGGER "note_amendment_no_truncate" BEFORE TRUNCATE ON "NoteAmendment"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_append_only"();
