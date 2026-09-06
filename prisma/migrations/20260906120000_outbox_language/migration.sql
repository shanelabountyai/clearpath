-- The language a message was actually written in, recorded on the message.
--
-- Deliberately nullable with no backfill. The obvious backfill — copy the
-- client's current language onto every historical row — would invent the
-- evidence this column exists to check: a client corrected from `en` to `es`
-- would have their old English reminders relabelled as Spanish, and the one
-- case the column is for would be the one case it erases. Null means "nobody
-- recorded what this was written in", and every reader here treats unknown as
-- unproven rather than as agreement.
ALTER TABLE "OutboxMessage" ADD COLUMN "language" "Language";
