# Next

**Item:** Phase 2 of `prd-intake-inquiry.md` — P0-1 (the `Inquiry` table),
P0-3 (discard reason codes), P0-5 (the trigger and the purge sweep), P0-6
(audit). This is where the deletion actually happens.

Phase 1 landed the verb and the state machine (`a2a6939`'s successor). Read
D-01, D-03, D-05 and D-06 before deviating.

## Model

**Opus.** Phase 1 was transcription; this is not. A migration that adds the
codebase's first `DELETE` path, a trigger that has to refuse everything else,
and an audit design that deliberately points at rows that no longer exist —
each one is a correctness decision with a wrong answer that looks fine in a
green test run.

## Phase 2, concretely

1. **`Inquiry` model.** Fields per P0-1. No `dateOfBirth`, no `code`, no
   `treatingClinicianId` — those three are what conversion is for. No relation
   to `ProgressNote`, `ProcessNote`, `FormRequest`, `FormSubmission`, `Alert`,
   `Appointment`, `PortalLink`, `OutboxMessage`, and a grep test in the style
   of `notes/service.test.ts` that fails the build if one appears.
2. **`InquiryDiscardReason`**: `no_answer`, `not_a_fit`, `referred_out`,
   `no_capacity`, `chose_elsewhere`, `duplicate`, `spam`. Codes, in the idiom
   of `FeeWaiveReason` — this value reaches the audit log.
3. **`inquiry_delete_only_discarded` trigger**, written in the migration
   alongside `audit_append_only` and `progress_note_content_frozen`. **In the
   migration, not in Prisma.**
4. **The purge sweep**, clock-driven off `PracticeSettings.inquiryRetentionDays`
   (default 90, new column). Idempotent. Actor `system`, action `discard`,
   `reason: 'purged'`.

## Traps

- **The trigger must be asserted against a real connection.** A mocked test
  proves nothing. Assert it refuses `open` AND refuses `converted`.
- **`AuditEvent.clientId` has no FK, and inquiry ids must never enter it.**
  That column means *a client record*. Rows about an inquiry carry
  `clientId: null` and `resourceId: <inquiry id>`. This is what lets a purged
  inquiry leave its audit rows standing with nothing dangling — D-06.
- **`Inquiry.inquiryId` on `WaitlistEntry` is `ON DELETE CASCADE`** — the only
  cascade in the schema, deliberate, and it lands in Phase 3 with P0-7.
- Discards carry `reason: 'discarded:<code>'`; the purge carries
  `reason: 'purged'`. Two different rows, both readable by the auditor.

## Gate at this commit

Unit **1907/1907** (was 1616 — +280 matrix cells from one new action × one new
resource, +11 explicit inquiry tests), typecheck clean. e2e not re-run: nothing
in this commit touches a rendered page or the schema.

Migrations **still not on production** — three:
`20260907191212_client_reminder_stages`, `20260907194526_client_language`,
`20260908103000_localized_form_labels`. `npm run db:migrate:prod` when that
matters. Phase 2 adds a fourth.

## Already answered, do not re-litigate

- `discard` not `delete`, and clinicians not discarding — settled, in the
  matrix and in WRITEUP §18.
- Break-glass has no `inquiry` cell, and a test asserts it stays that way.
- Group sessions and superbill depth are shipped. Both parent PRDs are closed.
