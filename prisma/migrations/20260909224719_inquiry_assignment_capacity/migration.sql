-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "assignedClinicianId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "acceptingNewClients" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Inquiry_status_assignedClinicianId_idx" ON "Inquiry"("status", "assignedClinicianId");

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_assignedClinicianId_fkey" FOREIGN KEY ("assignedClinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
