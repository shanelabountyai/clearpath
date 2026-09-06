-- CreateEnum
CREATE TYPE "Language" AS ENUM ('en', 'es');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "language" "Language" NOT NULL DEFAULT 'en';
