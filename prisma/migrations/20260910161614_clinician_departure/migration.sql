-- CreateEnum
CREATE TYPE "DepartureStatus" AS ENUM ('planned', 'executed', 'cancelled');

-- CreateEnum
CREATE TYPE "DepartureDisposition" AS ENUM ('transfer', 'discharge', 'referred_out');

-- DropForeignKey
ALTER TABLE "NoteAmendment" DROP CONSTRAINT "NoteAmendment_processNoteId_fkey";

-- AlterTable
ALTER TABLE "PracticeSettings" ADD COLUMN     "processNoteAfterDepartureDays" INTEGER NOT NULL DEFAULT 2555;

-- AlterTable
ALTER TABLE "ProcessNote" ADD COLUMN     "unreachableSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProgressNote" ADD COLUMN     "abandonedByDepartureId" TEXT;

-- CreateTable
CREATE TABLE "Departure" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noticeAt" TIMESTAMP(3) NOT NULL,
    "lastDayOn" DATE NOT NULL,
    "status" "DepartureStatus" NOT NULL DEFAULT 'planned',
    "plannedById" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Departure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartureAssignment" (
    "id" TEXT NOT NULL,
    "departureId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "disposition" "DepartureDisposition" NOT NULL,
    "receivingClinicianId" TEXT,
    "referredOutToId" TEXT,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepartureAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Departure_status_lastDayOn_idx" ON "Departure"("status", "lastDayOn");

-- CreateIndex
CREATE INDEX "Departure_userId_idx" ON "Departure"("userId");

-- CreateIndex
CREATE INDEX "DepartureAssignment_clientId_idx" ON "DepartureAssignment"("clientId");

-- CreateIndex
CREATE INDEX "DepartureAssignment_receivingClinicianId_idx" ON "DepartureAssignment"("receivingClinicianId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartureAssignment_departureId_clientId_key" ON "DepartureAssignment"("departureId", "clientId");

-- CreateIndex
CREATE INDEX "ProcessNote_unreachableSince_idx" ON "ProcessNote"("unreachableSince");

-- AddForeignKey
ALTER TABLE "ProgressNote" ADD CONSTRAINT "ProgressNote_abandonedByDepartureId_fkey" FOREIGN KEY ("abandonedByDepartureId") REFERENCES "Departure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteAmendment" ADD CONSTRAINT "NoteAmendment_processNoteId_fkey" FOREIGN KEY ("processNoteId") REFERENCES "ProcessNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Departure" ADD CONSTRAINT "Departure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Departure" ADD CONSTRAINT "Departure_plannedById_fkey" FOREIGN KEY ("plannedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartureAssignment" ADD CONSTRAINT "DepartureAssignment_departureId_fkey" FOREIGN KEY ("departureId") REFERENCES "Departure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartureAssignment" ADD CONSTRAINT "DepartureAssignment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartureAssignment" ADD CONSTRAINT "DepartureAssignment_receivingClinicianId_fkey" FOREIGN KEY ("receivingClinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartureAssignment" ADD CONSTRAINT "DepartureAssignment_referredOutToId_fkey" FOREIGN KEY ("referredOutToId") REFERENCES "Referrer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartureAssignment" ADD CONSTRAINT "DepartureAssignment_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────── the rules Prisma has no syntax for ──────────────────

-- P0-1: a person may leave twice in a career, but not twice at once. A plain
-- unique on "userId" would say the first half is impossible too, which is the
-- P2 "returning clinician" case and a real one. Partial, on the only
-- non-terminal status.
CREATE UNIQUE INDEX "departure_one_open_per_user" ON "Departure"("userId")
  WHERE "status" = 'planned';

-- The last day cannot precede the notice. The PRD's no-backdating rule is
-- about `noticeAt` against *today* and only application code knows what today
-- is; this half is a static fact about the row and belongs here.
ALTER TABLE "Departure" ADD CONSTRAINT "departure_last_day_after_notice"
  CHECK ("lastDayOn" >= "noticeAt"::date);

-- In the register of `inquiry_discard_is_complete`, and for the same reason: a
-- departure marked executed with no `executedAt` is an event with no date, and
-- an `executedAt` on a planned row says the caseload moved before anybody
-- pressed the button. Both are states the reports would read straight past.
ALTER TABLE "Departure" ADD CONSTRAINT "departure_execution_is_complete"
  CHECK (("status" = 'executed') = ("executedAt" IS NOT NULL));

-- Goal 2: no default and no silent remainder. A `transfer` with no receiving
-- clinician is an undecided row wearing a decision's clothes — the exact state
-- this table exists to make impossible — and a receiver on a `discharge` names
-- a colleague who is taking nobody. Biconditional, both directions wrong.
ALTER TABLE "DepartureAssignment" ADD CONSTRAINT "departure_transfer_has_a_receiver"
  CHECK (("receivingClinicianId" IS NOT NULL) = ("disposition" = 'transfer'));

-- One-directional, exactly like `inquiry_referred_out_has_a_reason`: a
-- destination recorded against a discharge describes a referral that did not
-- happen, while a `referred_out` with no destination is an honest row about a
-- practice down the road that is not in the contact list.
ALTER TABLE "DepartureAssignment" ADD CONSTRAINT "departure_destination_only_when_referred_out"
  CHECK ("referredOutToId" IS NULL OR "disposition" = 'referred_out');

-- P0-4b: `abandoned` is a fact with a cause attached. A note in that status
-- naming no departure is a draft somebody closed by hand, and a departure
-- named on a note in any other status is a claim the record cannot support.
ALTER TABLE "ProgressNote" ADD CONSTRAINT "progress_note_abandonment_has_a_cause"
  CHECK (("status" = 'abandoned') = ("abandonedByDepartureId" IS NOT NULL));

-- P0-4b, the transition. `abandoned` is terminal and reachable only from
-- `draft`: a signed note is already the record, and the one thing this status
-- must never become is a way to retire an inconvenient signature.
--
-- The rest of this function is unchanged from `init` — content frozen once the
-- note leaves draft, and no return to draft — and the new clauses ride on the
-- same reasoning, which is why they live here rather than in a second trigger
-- racing this one.
CREATE OR REPLACE FUNCTION "progress_note_content_frozen"() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'signed progress notes are immutable; append an amendment';
  END IF;
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a signed progress note cannot return to draft';
  END IF;
  IF NEW.status = 'abandoned' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft can be abandoned (was %)', OLD.status;
  END IF;
  IF OLD.status = 'abandoned' AND NEW.status <> 'abandoned' THEN
    RAISE EXCEPTION 'an abandoned note is terminal; its author is gone';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- P0-10: the second deletion rule in this codebase, written the same way as
-- the first (`inquiry_delete_only_discarded`) because hard rule 5's principle
-- generalises — the retention *window* is application policy and lives in
-- PracticeSettings, the invariant that a reachable process note may not be
-- destroyed at all is not.
--
-- This is the most sensitive table in the database and the one with a single
-- reader. `unreachableSince IS NULL` means that reader still exists, and a
-- future caller reaching for `processNote.delete()` should hit the database
-- rather than a code review.
CREATE OR REPLACE FUNCTION "process_note_delete_only_after_departure"() RETURNS trigger AS $$
BEGIN
  IF OLD."unreachableSince" IS NULL THEN
    RAISE EXCEPTION 'a process note can only be destroyed after its author departed';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "process_note_no_delete_unless_unreachable" BEFORE DELETE ON "ProcessNote"
  FOR EACH ROW EXECUTE FUNCTION "process_note_delete_only_after_departure"();

-- Amendments stay append-only, with exactly one hole in it.
--
-- An amendment carries its own `content`, so destroying a process note and
-- leaving its amendments behind destroys the row and keeps the text — which is
-- the P0-10 sweep quietly failing at the only thing it does. The FK is now
-- `ON DELETE CASCADE`, and the hole is the child rows that cascade takes with
-- it.
--
-- Stated as the ABSENCE of a reachable parent rather than the presence of an
-- unreachable one, and that is not a stylistic inversion. A cascade is an
-- AFTER-DELETE action on the parent, so by the time this trigger runs on the
-- child the process note is already gone and no `EXISTS` on it can ever be
-- true. `NOT EXISTS (… unreachableSince IS NULL)` is true in both orders — the
-- parent still present and unreachable, or already deleted, which it can only
-- be behind `process_note_delete_only_after_departure`. An amendment to a
-- reachable process note stays undeletable, a progress-note amendment stays
-- undeletable, and every UPDATE is refused as before.
CREATE OR REPLACE FUNCTION "note_amendment_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."processNoteId" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "ProcessNote" p
       WHERE p.id = OLD."processNoteId" AND p."unreachableSince" IS NULL
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'NoteAmendment is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "note_amendment_no_update" ON "NoteAmendment";

CREATE TRIGGER "note_amendment_no_update" BEFORE UPDATE OR DELETE ON "NoteAmendment"
  FOR EACH ROW EXECUTE FUNCTION "note_amendment_append_only"();
