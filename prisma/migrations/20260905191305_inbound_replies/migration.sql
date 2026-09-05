-- CreateEnum
CREATE TYPE "InboundClassification" AS ENUM ('confirm', 'decline', 'unparsed', 'opt_out');

-- AlterEnum
ALTER TYPE "AlertKind" ADD VALUE 'inbound_unparsed';

-- AlterTable
ALTER TABLE "PracticeSettings" ADD COLUMN     "contactPhone" TEXT NOT NULL DEFAULT '555-0100';

-- CreateTable
CREATE TABLE "InboundReply" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "classification" "InboundClassification" NOT NULL,
    "channel" "OutboxChannel" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,

    CONSTRAINT "InboundReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundReply_handledAt_receivedAt_idx" ON "InboundReply"("handledAt", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundReply_clientId_receivedAt_idx" ON "InboundReply"("clientId", "receivedAt");

-- AddForeignKey
ALTER TABLE "InboundReply" ADD CONSTRAINT "InboundReply_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundReply" ADD CONSTRAINT "InboundReply_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
