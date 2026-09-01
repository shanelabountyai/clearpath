-- CreateEnum
CREATE TYPE "Role" AS ENUM ('front_desk', 'therapist', 'associate', 'supervisor', 'admin', 'auditor');

-- CreateEnum
CREATE TYPE "ReminderPreference" AS ENUM ('email', 'sms', 'none');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "OverrideKind" AS ENUM ('unavailable', 'available');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('intake', 'standard', 'extended');

-- CreateEnum
CREATE TYPE "Modality" AS ENUM ('in_person', 'telehealth');

-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('weekly', 'biweekly');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('scheduled', 'confirmed', 'arrived', 'in_session', 'completed', 'no_show', 'cancelled', 'late_cancelled');

-- CreateEnum
CREATE TYPE "ProgressNoteStatus" AS ENUM ('draft', 'signed', 'cosigned');

-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('progress', 'process');

-- CreateEnum
CREATE TYPE "FormKind" AS ENUM ('intake', 'consent', 'screener');

-- CreateEnum
CREATE TYPE "FormRequestStatus" AS ENUM ('sent', 'started', 'submitted', 'expired');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('screener_threshold', 'screener_critical_item');

-- CreateEnum
CREATE TYPE "OutboxChannel" AS ENUM ('email', 'sms');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "supervisorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "emergencyContactRelation" TEXT,
    "treatingClinicianId" TEXT NOT NULL,
    "feeCents" INTEGER,
    "reminderPreference" "ReminderPreference" NOT NULL DEFAULT 'email',
    "status" "ClientStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL DEFAULT 'Stillwater Counseling',
    "standardFeeCents" INTEGER NOT NULL DEFAULT 18000,
    "lateCancelWindowHours" INTEGER NOT NULL DEFAULT 24,
    "lateCancelFeeCents" INTEGER NOT NULL DEFAULT 9000,
    "recurrenceHorizonDays" INTEGER NOT NULL DEFAULT 90,
    "continuityGapDays" INTEGER NOT NULL DEFAULT 21,

    CONSTRAINT "PracticeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "kind" "OverrideKind" NOT NULL DEFAULT 'unavailable',
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "reason" TEXT,

    CONSTRAINT "AvailabilityOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentSeries" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "roomId" TEXT,
    "type" "AppointmentType" NOT NULL DEFAULT 'standard',
    "modality" "Modality" NOT NULL DEFAULT 'in_person',
    "frequency" "Frequency" NOT NULL DEFAULT 'weekly',
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT,
    "detached" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "roomId" TEXT,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "type" "AppointmentType" NOT NULL DEFAULT 'standard',
    "modality" "Modality" NOT NULL DEFAULT 'in_person',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'scheduled',
    "joinLink" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "chargeFeeCents" INTEGER,
    "occurrenceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressNote" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "ProgressNoteStatus" NOT NULL DEFAULT 'draft',
    "signedAt" TIMESTAMP(3),
    "coSignedById" TEXT,
    "coSignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessNote" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT,
    "clientId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteAmendment" (
    "id" TEXT NOT NULL,
    "kind" "NoteKind" NOT NULL,
    "progressNoteId" TEXT,
    "processNoteId" TEXT,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FormKind" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "schema" JSONB NOT NULL,
    "scoring" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "FormRequestStatus" NOT NULL DEFAULT 'sent',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "FormRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "totalScore" INTEGER,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signatureName" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "submissionId" TEXT,
    "kind" "AlertKind" NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "userId" TEXT,
    "channel" "OutboxChannel" NOT NULL,
    "templateKey" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "earliestMinute" INTEGER,
    "latestMinute" INTEGER,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "actorRole" "Role" NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "clientId" TEXT,
    "allowed" BOOLEAN NOT NULL,
    "rule" TEXT NOT NULL,
    "breakGlass" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Client_code_key" ON "Client"("code");

-- CreateIndex
CREATE INDEX "Client_treatingClinicianId_idx" ON "Client"("treatingClinicianId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_name_key" ON "Room"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Availability_userId_weekday_startMinute_key" ON "Availability"("userId", "weekday", "startMinute");

-- CreateIndex
CREATE INDEX "AvailabilityOverride_userId_fromDate_idx" ON "AvailabilityOverride"("userId", "fromDate");

-- CreateIndex
CREATE INDEX "AppointmentSeries_clientId_idx" ON "AppointmentSeries"("clientId");

-- CreateIndex
CREATE INDEX "AppointmentSeries_clinicianId_idx" ON "AppointmentSeries"("clinicianId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_occurrenceKey_key" ON "Appointment"("occurrenceKey");

-- CreateIndex
CREATE INDEX "Appointment_clinicianId_startAt_idx" ON "Appointment"("clinicianId", "startAt");

-- CreateIndex
CREATE INDEX "Appointment_clientId_startAt_idx" ON "Appointment"("clientId", "startAt");

-- CreateIndex
CREATE INDEX "Appointment_roomId_startAt_idx" ON "Appointment"("roomId", "startAt");

-- CreateIndex
CREATE INDEX "Appointment_status_startAt_idx" ON "Appointment"("status", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProgressNote_appointmentId_key" ON "ProgressNote"("appointmentId");

-- CreateIndex
CREATE INDEX "ProgressNote_clientId_idx" ON "ProgressNote"("clientId");

-- CreateIndex
CREATE INDEX "ProgressNote_authorId_status_idx" ON "ProgressNote"("authorId", "status");

-- CreateIndex
CREATE INDEX "ProcessNote_authorId_clientId_idx" ON "ProcessNote"("authorId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "FormTemplate_key_version_key" ON "FormTemplate"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FormRequest_token_key" ON "FormRequest"("token");

-- CreateIndex
CREATE INDEX "FormRequest_clientId_status_idx" ON "FormRequest"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FormSubmission_requestId_key" ON "FormSubmission"("requestId");

-- CreateIndex
CREATE INDEX "FormSubmission_clientId_idx" ON "FormSubmission"("clientId");

-- CreateIndex
CREATE INDEX "Alert_recipientId_acknowledgedAt_idx" ON "Alert"("recipientId", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_scheduledFor_sentAt_idx" ON "OutboxMessage"("scheduledFor", "sentAt");

-- CreateIndex
CREATE INDEX "AuditEvent_clientId_at_idx" ON "AuditEvent"("clientId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_at_idx" ON "AuditEvent"("actorId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_breakGlass_at_idx" ON "AuditEvent"("breakGlass", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_at_idx" ON "AuditEvent"("at");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_treatingClinicianId_fkey" FOREIGN KEY ("treatingClinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityOverride" ADD CONSTRAINT "AvailabilityOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentSeries" ADD CONSTRAINT "AppointmentSeries_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentSeries" ADD CONSTRAINT "AppointmentSeries_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentSeries" ADD CONSTRAINT "AppointmentSeries_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "AppointmentSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressNote" ADD CONSTRAINT "ProgressNote_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressNote" ADD CONSTRAINT "ProgressNote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressNote" ADD CONSTRAINT "ProgressNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressNote" ADD CONSTRAINT "ProgressNote_coSignedById_fkey" FOREIGN KEY ("coSignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNote" ADD CONSTRAINT "ProcessNote_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNote" ADD CONSTRAINT "ProcessNote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNote" ADD CONSTRAINT "ProcessNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteAmendment" ADD CONSTRAINT "NoteAmendment_progressNoteId_fkey" FOREIGN KEY ("progressNoteId") REFERENCES "ProgressNote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteAmendment" ADD CONSTRAINT "NoteAmendment_processNoteId_fkey" FOREIGN KEY ("processNoteId") REFERENCES "ProcessNote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteAmendment" ADD CONSTRAINT "NoteAmendment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormRequest" ADD CONSTRAINT "FormRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormRequest" ADD CONSTRAINT "FormRequest_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "FormRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────
-- Constraints the ORM cannot express. These are the load-bearing ones.
-- ────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- P0-4: a room is required for in-person and forbidden for telehealth. The
-- conditional resource is a database invariant, not an application habit.
ALTER TABLE "Appointment" ADD CONSTRAINT "appointment_room_matches_modality"
  CHECK (
    (modality = 'in_person'  AND "roomId" IS NOT NULL) OR
    (modality = 'telehealth' AND "roomId" IS NULL)
  );

ALTER TABLE "Appointment" ADD CONSTRAINT "appointment_ends_after_start"
  CHECK ("endAt" > "startAt");

-- P0-4: zero double-bookings of either resource, decided by Postgres rather
-- than by a read-then-write race in application code. Two concurrent bookings
-- of the last room: exactly one commits, the other gets 23P01.
ALTER TABLE "Appointment" ADD CONSTRAINT "appointment_clinician_no_overlap"
  EXCLUDE USING gist (
    "clinicianId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'late_cancelled'));

ALTER TABLE "Appointment" ADD CONSTRAINT "appointment_room_no_overlap"
  EXCLUDE USING gist (
    "roomId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  ) WHERE ("roomId" IS NOT NULL AND status NOT IN ('cancelled', 'late_cancelled'));

-- P0-2: the audit log is append-only. UPDATE and DELETE are refused loudly, so
-- a tamper attempt surfaces as an error rather than a silent no-op.
--
-- Honest limitation: a role that can DROP the trigger or the table can still
-- destroy history. Real tamper-evidence needs the log shipped off the box.
-- What this buys is that no application bug and no ordinary hand-run UPDATE
-- can rewrite an audit row.
CREATE OR REPLACE FUNCTION "audit_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_event_no_update" BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "audit_append_only"();

-- Amendments are the correction mechanism, so they are append-only too.
CREATE TRIGGER "note_amendment_no_update" BEFORE UPDATE OR DELETE ON "NoteAmendment"
  FOR EACH ROW EXECUTE FUNCTION "audit_append_only"();

-- P0-7: a signed note's content is immutable. Co-signing still updates status
-- and signature columns, so only the content is frozen.
CREATE OR REPLACE FUNCTION "progress_note_content_frozen"() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'signed progress notes are immutable; append an amendment';
  END IF;
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a signed progress note cannot return to draft';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "progress_note_immutable" BEFORE UPDATE ON "ProgressNote"
  FOR EACH ROW EXECUTE FUNCTION "progress_note_content_frozen"();

CREATE OR REPLACE FUNCTION "process_note_content_frozen"() RETURNS trigger AS $$
BEGIN
  IF OLD."closedAt" IS NOT NULL AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'closed process notes are immutable; append an amendment';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "process_note_immutable" BEFORE UPDATE ON "ProcessNote"
  FOR EACH ROW EXECUTE FUNCTION "process_note_content_frozen"();

-- Practice settings is a singleton.
ALTER TABLE "PracticeSettings" ADD CONSTRAINT "practice_settings_singleton"
  CHECK (id = 1);
