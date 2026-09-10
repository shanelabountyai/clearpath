-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "referredOutToId" TEXT,
ADD COLUMN     "referrerId" TEXT;

-- CreateTable
CREATE TABLE "Referrer" (
    "id" TEXT NOT NULL,
    "practice" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referrer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Referrer_active_idx" ON "Referrer"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Referrer_practice_name_key" ON "Referrer"("practice", "name");

-- CreateIndex
CREATE INDEX "Inquiry_referrerId_idx" ON "Inquiry"("referrerId");

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Referrer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_referredOutToId_fkey" FOREIGN KEY ("referredOutToId") REFERENCES "Referrer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The code and the entity are one fact. "A friend sent them, and the surgery
-- was Riverside" is not a row worth validating on the way in — it is a row that
-- should not be representable, so the rule lives here rather than in a
-- validator somebody can route around with a hand-rolled POST.
ALTER TABLE "Inquiry" ADD CONSTRAINT "inquiry_referrer_only_for_gp"
  CHECK ("referrerId" IS NULL OR "referralSource" = 'gp');

-- Same argument, other direction: a destination on an enquiry that was not
-- referred out records an act that did not happen, and `referred_out` is the
-- one discard reason with its own 365-day retention window precisely because
-- it is a record of the practice having acted.
ALTER TABLE "Inquiry" ADD CONSTRAINT "inquiry_referred_out_has_a_reason"
  CHECK ("referredOutToId" IS NULL OR "discardReason" = 'referred_out');
