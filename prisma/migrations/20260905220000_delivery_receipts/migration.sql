-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('queued', 'sent', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "DeliveryFailure" AS ENUM ('invalid_destination', 'unreachable', 'rejected', 'opted_out_at_carrier', 'carrier_unavailable', 'expired');

-- AlterTable
ALTER TABLE "OutboxMessage" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryState" "DeliveryState" NOT NULL DEFAULT 'queued',
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "failureCode" "DeliveryFailure",
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "providerRef" TEXT;

-- CreateTable
CREATE TABLE "DeliveryReceipt" (
    "id" TEXT NOT NULL,
    "outboxMessageId" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "state" "DeliveryState" NOT NULL,
    "failureCode" "DeliveryFailure",
    "attempt" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ignored" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DeliveryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryReceipt_outboxMessageId_occurredAt_idx" ON "DeliveryReceipt"("outboxMessageId", "occurredAt");

-- CreateIndex
CREATE INDEX "DeliveryReceipt_providerRef_idx" ON "DeliveryReceipt"("providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_providerRef_key" ON "OutboxMessage"("providerRef");

-- CreateIndex
CREATE INDEX "OutboxMessage_deliveryState_nextAttemptAt_idx" ON "OutboxMessage"("deliveryState", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_outboxMessageId_fkey" FOREIGN KEY ("outboxMessageId") REFERENCES "OutboxMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryReceipt" ADD CONSTRAINT "DeliveryReceipt_outboxMessageId_fkey" FOREIGN KEY ("outboxMessageId") REFERENCES "OutboxMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

