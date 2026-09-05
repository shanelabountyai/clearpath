-- CreateEnum
CREATE TYPE "AppointmentConfirmation" AS ENUM ('not_required', 'pending', 'confirmed', 'declined', 'no_response');

-- CreateEnum
CREATE TYPE "FeeWaiveReason" AS ENUM ('practice_error', 'client_disputed', 'emergency', 'goodwill');

-- CreateEnum
CREATE TYPE "ReminderStage" AS ENUM ('d5', 'd1', 'd0');

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "confirmation" "AppointmentConfirmation" NOT NULL DEFAULT 'not_required',
ADD COLUMN     "feeWaiveReason" "FeeWaiveReason",
ADD COLUMN     "feeWaivedAt" TIMESTAMP(3),
ADD COLUMN     "feeWaivedById" TEXT;

-- AlterTable
ALTER TABLE "PracticeSettings" ADD COLUMN     "autoNoShowOnNoResponse" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dayOfLeadHours" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "graceMinutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "noShowFeeCents" INTEGER NOT NULL DEFAULT 9000;

-- CreateTable
CREATE TABLE "AppointmentReminder" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "stage" "ReminderStage" NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "outboxMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentReminder_dueAt_sentAt_idx" ON "AppointmentReminder"("dueAt", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentReminder_appointmentId_stage_key" ON "AppointmentReminder"("appointmentId", "stage");

-- CreateIndex
CREATE INDEX "Appointment_confirmation_startAt_idx" ON "Appointment"("confirmation", "startAt");

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
