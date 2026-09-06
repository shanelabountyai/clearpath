-- When this hour was set, as opposed to when the row was made.
--
-- Backfilled from `createdAt`, which is the truth for every appointment that
-- has never been moved and the best available answer for the ones that have:
-- before this migration nothing recorded a reschedule's moment, so there is
-- nothing to recover it from. The backfill is therefore deliberately generous
-- in the same direction the old code was, and the guarantee starts here.
ALTER TABLE "Appointment" ADD COLUMN "bookedAt" TIMESTAMPTZ(3);
UPDATE "Appointment" SET "bookedAt" = "createdAt" WHERE "bookedAt" IS NULL;
ALTER TABLE "Appointment" ALTER COLUMN "bookedAt" SET NOT NULL;

-- The reminder key names the hour it asked about. See the schema comment: a
-- moved appointment gets new stage moments, so the cadence may ask again
-- without the withdrawn hour's rows blocking it, and those rows survive as the
-- proof that it did ask the first time.
DROP INDEX "AppointmentReminder_appointmentId_stage_key";
CREATE UNIQUE INDEX "AppointmentReminder_appointmentId_stage_dueAt_key"
  ON "AppointmentReminder"("appointmentId", "stage", "dueAt");
