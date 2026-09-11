-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "coveringLeaveId" TEXT;

-- CreateTable
CREATE TABLE "Leave" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "coveringClinicianId" TEXT NOT NULL,
    "plannedById" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "overrideId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Leave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveCoverage" (
    "id" TEXT NOT NULL,
    "leaveId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "coveringClinicianId" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Leave_overrideId_key" ON "Leave"("overrideId");

-- CreateIndex
CREATE INDEX "Leave_userId_idx" ON "Leave"("userId");

-- CreateIndex
CREATE INDEX "Leave_coveringClinicianId_idx" ON "Leave"("coveringClinicianId");

-- CreateIndex
CREATE INDEX "LeaveCoverage_coveringClinicianId_idx" ON "LeaveCoverage"("coveringClinicianId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveCoverage_leaveId_clientId_key" ON "LeaveCoverage"("leaveId", "clientId");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_coveringLeaveId_fkey" FOREIGN KEY ("coveringLeaveId") REFERENCES "Leave"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_coveringClinicianId_fkey" FOREIGN KEY ("coveringClinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_plannedById_fkey" FOREIGN KEY ("plannedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_overrideId_fkey" FOREIGN KEY ("overrideId") REFERENCES "AvailabilityOverride"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveCoverage" ADD CONSTRAINT "LeaveCoverage_leaveId_fkey" FOREIGN KEY ("leaveId") REFERENCES "Leave"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveCoverage" ADD CONSTRAINT "LeaveCoverage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveCoverage" ADD CONSTRAINT "LeaveCoverage_coveringClinicianId_fkey" FOREIGN KEY ("coveringClinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveCoverage" ADD CONSTRAINT "LeaveCoverage_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────── the rules Prisma has no syntax for ──────────────────

-- P0-1: a person may book summer and winter leave ahead, but not two leaves
-- over the same days. Inclusive at both ends, like the columns: a leave ending
-- on the 27th and another starting on the 27th share a day and are refused.
-- A cancelled leave is outside the constraint, so its dates are free again.
-- `btree_gist` is already installed by `init`.
ALTER TABLE "Leave" ADD CONSTRAINT "leave_no_overlap"
  EXCLUDE USING gist (
    "userId" WITH =,
    daterange("fromDate", "toDate", '[]') WITH &&
  ) WHERE ("cancelledAt" IS NULL);

ALTER TABLE "Leave" ADD CONSTRAINT "leave_ends_after_it_starts"
  CHECK ("toDate" >= "fromDate");

-- D-03 names a coverer so that somebody at work holds the caseload. Naming the
-- person away is a leave with nobody covering it, dressed as one with somebody.
ALTER TABLE "Leave" ADD CONSTRAINT "leave_coverer_is_not_away"
  CHECK ("coveringClinicianId" <> "userId");

-- P0-7, in the register of `departure_execution_is_complete`: a live leave
-- owns its calendar row, and cancellation removes it. A cancelled leave still
-- blocking the calendar books nobody into weeks the clinician is at work; a
-- live one without the row lets front desk book into weeks they are not.
ALTER TABLE "Leave" ADD CONSTRAINT "leave_calendar_row_while_live"
  CHECK (("cancelledAt" IS NULL) = ("overrideId" IS NOT NULL));

-- The same rule for the per-client override. A CHECK cannot see the leave, so
-- this is a trigger. It reads `Leave.userId`, which nothing ever updates.
CREATE OR REPLACE FUNCTION "leave_coverage_coverer_is_not_away"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Leave" l
    WHERE l.id = NEW."leaveId" AND l."userId" = NEW."coveringClinicianId"
  ) THEN
    RAISE EXCEPTION 'leave_coverage_coverer_is_not_away: a client cannot be covered by the person away';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "leave_coverage_coverer_is_not_away" BEFORE INSERT OR UPDATE ON "LeaveCoverage"
  FOR EACH ROW EXECUTE FUNCTION "leave_coverage_coverer_is_not_away"();
