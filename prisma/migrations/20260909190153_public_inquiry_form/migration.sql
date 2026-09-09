-- DropForeignKey
ALTER TABLE "Inquiry" DROP CONSTRAINT "Inquiry_takenById_fkey";

-- AlterTable
ALTER TABLE "Inquiry" ALTER COLUMN "takenById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PracticeSettings" ADD COLUMN     "publicInquiryEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicInquiryPerHour" INTEGER NOT NULL DEFAULT 3;

-- CreateTable
CREATE TABLE "InquiryThrottle" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InquiryThrottle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InquiryThrottle_windowStartedAt_idx" ON "InquiryThrottle"("windowStartedAt");

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_takenById_fkey" FOREIGN KEY ("takenById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
