-- CreateEnum
CREATE TYPE "ReminderCadence" AS ENUM ('full', 'day_before', 'day_of');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "reminderCadence" "ReminderCadence" NOT NULL DEFAULT 'full';
