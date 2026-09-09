-- AlterTable
ALTER TABLE "PracticeSettings" ADD COLUMN     "referredOutRetentionDays" INTEGER NOT NULL DEFAULT 365,
ADD COLUMN     "spamRetentionDays" INTEGER NOT NULL DEFAULT 7;
