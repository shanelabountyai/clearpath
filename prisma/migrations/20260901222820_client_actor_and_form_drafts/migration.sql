-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'client';

-- AlterTable
ALTER TABLE "FormRequest" ADD COLUMN     "draftAnswers" JSONB;
