-- CreateEnum
CREATE TYPE "InboundClassification" AS ENUM ('confirm', 'decline', 'unparsed');

-- AlterEnum
ALTER TYPE "AlertKind" ADD VALUE 'inbound_unparsed';

-- AlterTable
ALTER TABLE "PracticeSettings" ADD COLUMN     "practicePhone" TEXT NOT NULL DEFAULT '(555) 010-0199';

-- CreateTable
CREATE TABLE "InboundReply" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "classification" "InboundClassification" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),

    CONSTRAINT "InboundReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundReply_classification_handledAt_idx" ON "InboundReply"("classification", "handledAt");

-- CreateIndex
CREATE INDEX "InboundReply_clientId_idx" ON "InboundReply"("clientId");

-- AddForeignKey
ALTER TABLE "InboundReply" ADD CONSTRAINT "InboundReply_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundReply" ADD CONSTRAINT "InboundReply_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundReply" ADD CONSTRAINT "InboundReply_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
