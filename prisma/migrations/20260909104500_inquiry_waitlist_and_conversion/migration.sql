-- P0-7 (the waitlist accepts an inquiry), P0-8 (conversion), P0-9 (referral
-- source on the client).

-- The exactly-one rule is checked against the data *before* the column that
-- could violate it exists, in the style of the localized-labels migration.
-- Every entry today belongs to a client, so the constraint holds on day one —
-- but "holds" is a claim about rows, and a migration that adds a constraint
-- without looking is a deploy that fails somewhere less convenient than here.
DO $$
DECLARE orphans bigint;
BEGIN
  SELECT count(*) INTO orphans FROM "WaitlistEntry" WHERE "clientId" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'cannot add the client-xor-inquiry rule: % waitlist entries already name no client', orphans;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "WaitlistEntry"
  ALTER COLUMN "clientId" DROP NOT NULL,
  ADD COLUMN "inquiryId" TEXT;

-- The only ON DELETE CASCADE in this schema, and it sits next to the only
-- DELETE path in it. Every other relation to Inquiry is RESTRICT, and by P0-1
-- there are none: an inquiry can reach a waitlist entry and nothing else.
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_inquiryId_fkey"
  FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "WaitlistEntry_inquiryId_idx" ON "WaitlistEntry"("inquiryId");

-- An entry belongs to somebody, and to exactly one somebody. Both halves
-- matter: neither leaves a row nobody can ring, both leaves a row that would
-- be offered an hour twice and repointed at conversion into a contradiction.
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "waitlist_entry_client_xor_inquiry"
  CHECK (("clientId" IS NULL) <> ("inquiryId" IS NULL));

-- AlterTable: the conversion column, deliberately left out of Phase 2 because
-- there was nothing that could set it.
ALTER TABLE "Inquiry" ADD COLUMN "clientId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_clientId_key" ON "Inquiry"("clientId");

-- RESTRICT, like every other relation pointing at a client: Client is the FK
-- root of every clinical table and nothing deletes one. The deletable end of
-- this relation is the other one.
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: the same fact at the business tier (P0-9). Nullable rather than
-- defaulted, because the ninety-seven clients already here were not asked, and
-- a default would enter "other" as if somebody had answered it.
ALTER TABLE "Client"
  ADD COLUMN "referralSource" "ReferralSource",
  ADD COLUMN "referralNote" TEXT;
