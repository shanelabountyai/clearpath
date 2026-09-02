-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "groupSessionId" TEXT;

-- CreateTable
CREATE TABLE "GroupSession" (
    "id" TEXT NOT NULL,
    "topic" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Appointment_groupSessionId_idx" ON "Appointment"("groupSessionId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_groupSessionId_fkey" FOREIGN KEY ("groupSessionId") REFERENCES "GroupSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────
-- P2: co-attendees are one booking, not N double-bookings.
--
-- A group session is N appointment rows sharing a groupSessionId — one per
-- attendee, so each keeps its own note, fee, attendance and audit trail. But
-- the clinician and room exclusion constraints would reject every row after the
-- first, since they see the same clinician in the same room at the same time.
--
-- Adding the group key as a third excluded column fixes that without weakening
-- anything: two rows now conflict only if they share the resource, OVERLAP in
-- time, AND belong to different bookings. COALESCE to the row's own id is what
-- keeps individual appointments conflicting — a NULL group key would make
-- `<>` return NULL for every pair of ordinary appointments, which is not true,
-- so the constraint would stop firing entirely. Each individual row instead
-- gets a key unique to itself, so it differs from every other row.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE "Appointment" DROP CONSTRAINT "appointment_clinician_no_overlap";
ALTER TABLE "Appointment" ADD CONSTRAINT "appointment_clinician_no_overlap"
  EXCLUDE USING gist (
    "clinicianId" WITH =,
    (COALESCE("groupSessionId", id)) WITH <>,
    tstzrange("startAt", "endAt", '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'late_cancelled'));

ALTER TABLE "Appointment" DROP CONSTRAINT "appointment_room_no_overlap";
ALTER TABLE "Appointment" ADD CONSTRAINT "appointment_room_no_overlap"
  EXCLUDE USING gist (
    "roomId" WITH =,
    (COALESCE("groupSessionId", id)) WITH <>,
    tstzrange("startAt", "endAt", '[)') WITH &&
  ) WHERE ("roomId" IS NOT NULL AND status NOT IN ('cancelled', 'late_cancelled'));
