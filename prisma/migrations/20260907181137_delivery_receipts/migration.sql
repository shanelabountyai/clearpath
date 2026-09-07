-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('queued', 'sent', 'delivered', 'failed');

-- AlterTable
ALTER TABLE "OutboxMessage" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryState" "DeliveryState" NOT NULL DEFAULT 'queued',
ADD COLUMN     "failureCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentReminder_outboxMessageId_key" ON "AppointmentReminder"("outboxMessageId");

-- CreateIndex
CREATE INDEX "OutboxMessage_deliveryState_idx" ON "OutboxMessage"("deliveryState");

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_outboxMessageId_fkey" FOREIGN KEY ("outboxMessageId") REFERENCES "OutboxMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

