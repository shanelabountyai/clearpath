-- AlterTable
ALTER TABLE "Leave" ADD COLUMN     "coveringSupervisorId" TEXT;

-- CreateIndex
CREATE INDEX "Leave_coveringSupervisorId_idx" ON "Leave"("coveringSupervisorId");

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_coveringSupervisorId_fkey" FOREIGN KEY ("coveringSupervisorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- P1-3, in the register of `leave_coverer_is_not_away`: naming the supervisor
-- away as their own cover is supervision nobody at work holds, dressed as
-- supervision somebody does. NULL passes, because most people away supervise
-- nobody; the door requires a cover when they do (D-22).
ALTER TABLE "Leave" ADD CONSTRAINT "leave_supervision_cover_is_not_away"
  CHECK ("coveringSupervisorId" <> "userId");
