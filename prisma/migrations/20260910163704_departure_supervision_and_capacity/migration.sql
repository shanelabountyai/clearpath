-- DropForeignKey
ALTER TABLE "ProgressNote" DROP CONSTRAINT "ProgressNote_coSignedById_fkey";

-- AlterTable
ALTER TABLE "Departure" ADD COLUMN     "acceptingNewClientsAtNotice" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "receivingSupervisorId" TEXT;

-- AddForeignKey
ALTER TABLE "ProgressNote" ADD CONSTRAINT "ProgressNote_coSignedById_fkey" FOREIGN KEY ("coSignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Departure" ADD CONSTRAINT "Departure_receivingSupervisorId_fkey" FOREIGN KEY ("receivingSupervisorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────── the rules Prisma has no syntax for ──────────────────

-- P0-8. Repointing a supervision tree at the person whose last day this is
-- leaves every associate answering to a deactivated account — a decision that
-- looks made and is a no-op. The application refuses it too, and this is the
-- half that a later caller writing straight to the table cannot get around.
--
-- Null passes: most people leaving supervise nobody, and a departing
-- supervisor who still has supervisees and no receiver is refused at execution
-- instead, because a CHECK cannot see the `User` rows that make it required.
ALTER TABLE "Departure" ADD CONSTRAINT "departure_supervisor_is_not_the_leaver"
  CHECK ("receivingSupervisorId" IS NULL OR "receivingSupervisorId" <> "userId");
