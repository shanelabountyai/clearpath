-- CreateEnum
CREATE TYPE "ReferralSource" AS ENUM ('gp', 'friend', 'search', 'other');

-- CreateEnum
CREATE TYPE "InquiryDiscardReason" AS ENUM ('no_answer', 'not_a_fit', 'referred_out', 'no_capacity', 'chose_elsewhere', 'duplicate', 'spam');

-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('open', 'converted', 'discarded');

-- AlterTable
ALTER TABLE "PracticeSettings" ADD COLUMN     "inquiryRetentionDays" INTEGER NOT NULL DEFAULT 90;

-- CreateTable
CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "requestedClinicianId" TEXT,
    "referralSource" "ReferralSource" NOT NULL,
    "referralNote" TEXT,
    "note" TEXT,
    "status" "InquiryStatus" NOT NULL DEFAULT 'open',
    "discardReason" "InquiryDiscardReason",
    "discardedAt" TIMESTAMP(3),
    "takenById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Inquiry_status_discardedAt_idx" ON "Inquiry"("status", "discardedAt");

-- CreateIndex
CREATE INDEX "Inquiry_requestedClinicianId_idx" ON "Inquiry"("requestedClinicianId");

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_requestedClinicianId_fkey" FOREIGN KEY ("requestedClinicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_takenById_fkey" FOREIGN KEY ("takenById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- P0-5: the codebase's first deletion rule, written the same way as its
-- immutability rules (`audit_append_only`, `progress_note_content_frozen`)
-- because hard rule 5's principle generalises. The retention *window* is
-- application policy and lives in PracticeSettings; the invariant that only a
-- discarded inquiry may be destroyed at all is not application policy, and a
-- future caller reaching for `inquiry.delete()` should hit the database.
--
-- A converted inquiry is refused by the same rule: it is part of a client's
-- history now, and there is no separate branch saying so.
--
-- TRUNCATE does not fire row triggers, which is what keeps `resetDb()` working
-- and is also why this cannot be the only thing standing between the
-- application and a wipe. It is the rule for row-at-a-time deletion, which is
-- the only kind any code path here performs.
CREATE OR REPLACE FUNCTION "inquiry_delete_only_discarded"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'discarded' THEN
    RAISE EXCEPTION 'an inquiry can only be deleted once discarded (status %)', OLD."status";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "inquiry_no_delete_unless_discarded" BEFORE DELETE ON "Inquiry"
  FOR EACH ROW EXECUTE FUNCTION "inquiry_delete_only_discarded"();

-- A discarded row with no `discardedAt` is one the sweep can never reach, and a
-- discarded row with no reason code is a row the audit log cannot describe.
-- Both are deletable-in-principle and immortal-in-practice, which is the exact
-- failure this PRD exists to refuse.
ALTER TABLE "Inquiry" ADD CONSTRAINT "inquiry_discard_is_complete"
  CHECK (("status" = 'discarded') = ("discardedAt" IS NOT NULL AND "discardReason" IS NOT NULL));
