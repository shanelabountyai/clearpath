# PRD: Intake — the inquiry stage, and the first thing in Clearpath that can be deleted

**Sample business:** "Stillwater Counseling" (as in the parent PRD) — 6 clinicians, 4 rooms, ~70 standing weekly clients
**Builder:** Solo, in Claude Code
**Status:** Draft v1.0 — feature PRD, child of `prd-clearpath-counseling-ops.md`. Sibling of `prd-appointment-confirmation.md`
**Learning objectives:** a stage that exists *before* the record everything else keys on; a deletion path inside a system built end to end on append-only audit and immutable notes, and the database rule that keeps that path narrow; the same fact held at two sensitivity tiers on purpose, so the role allowed to run the business report is not the role allowed to read the clinical answer

---

## ⚠️ Scope Honesty (read first)

This is a **learning project with synthetic data only**. Nothing here rings anybody, and nothing here texts anybody: `OutboxMessage` rows remain the stub. It applies HIPAA-*inspired* design principles — no PHI in messages, URLs, logs, or the audit trail — because they are excellent engineering discipline. It is **not** HIPAA-compliant software and must never hold real client data.

One honesty note specific to this feature: **retention and destruction of intake records is a jurisdictional legal question, not an engineering one.** This PRD designs a mechanism with a configurable window and a database rule that keeps it narrow. It does not claim 90 days is the right number anywhere. The settings page says so.

## Problem Statement

A person rings a counseling practice. In Clearpath today, there is nowhere to put them.

`Client.dateOfBirth` and `Client.treatingClinicianId` are both required, and `Client.code` is unique. So the first row a practice can create about a caller already asserts three things nobody knows on a first phone call: their date of birth, which clinician will treat them, and that they are a client of this practice at all. `WaitlistEntry.clientId` is required and `FormRequest.clientId` is required, so the two things front desk actually wants to do with a caller — put them on the list for a Tuesday evening that does not exist yet, or note who they asked for — both require inventing a full clinical record first.

**What exists today, accurately:**

- `Client` is the root of everything. Appointments, notes, forms, outbox, portal links and waitlist entries all FK to it with `ON DELETE RESTRICT`.
- The seed acknowledges the gap in a comment (`prisma/seed.ts`: "the last few are new referrals") by *pretending* — those callers are already full `Client` rows with a clinician assigned.
- The intake form asks "How did you hear about us?" — but the answer lands in a `FormSubmission`, which the matrix guards at `treatingOrSupervising`. **Front desk and the practice manager cannot read it.** The practice therefore cannot answer "where do our clients come from" without a clinician doing it for them.
- Nothing in this codebase can be deleted. Audit rows are append-only by trigger; signed progress notes and closed process notes are frozen by trigger. That is correct for every table that exists — and it is exactly why an inquiry cannot simply be a `Client` with some nulls.

The real cost is not the missing row. It is that **roughly half of inquiries go nowhere**, and a system whose only shape for a person is a permanent, undeletable clinical record turns every unanswered voicemail into a record of somebody who never became a client and never consented to being one.

## Goals

1. Front desk can record a phone inquiry in under thirty seconds, with nothing they do not know.
2. An inquiry that goes nowhere is **actually deleted** — not tombstoned, not `active = false` forever.
3. Deletion is narrow enough that nobody can aim it at a client record, and that narrowness is enforced by the database, not by a code review.
4. The audit trail survives the deletion and stays honest about what it can no longer tell you.
5. Conversion to a client is one explicit act that captures the two facts a first call cannot: date of birth and treating clinician.
6. `referralSource` becomes answerable by the roles that run the business, without any of them reading a clinical answer.

## Non-Goals

- **No messaging to an inquiry.** No email, no SMS, no tokenized link, no portal. Nobody who has not yet agreed to be a client gets a message from this practice — that is the disclosure risk the whole codebase is built to avoid, and "we texted the number they left" is how it happens. Front desk rings them back.
- **No form request to an inquiry.** `FormRequest.clientId` stays required. An intake packet is sent at conversion, which is precisely when the practice has agreed to see someone. Making that FK nullable would buy one week of convenience and permanently weaken the invariant that a form answer belongs to a client record.
- **No clinical content on an inquiry, of any kind.** No notes, no submissions, no alerts, no screener. This is not a restriction to work around later; it is the enabling constraint that makes the row deletable.
- **No de-duplication against clinical history.** "Has this caller been a client before?" is a real question and the answer lives behind a permission front desk does not have. See P1-2 for the operational half.
- **No reconciliation between the intake form's referral answer and the client field.** They are the same fact at two tiers and they stay independent — see D-04.
- No inbound web form, no scheduling widget, no insurance verification.

## Personas

- **Dana, front desk.** Takes every call. Needs a row, a name, a number, and what the person asked for. Owns the follow-up and owns declaring an inquiry dead.
- **Ray, practice manager (admin).** Wants to know how many calls became clients, from which sources, and how long that took. Cannot open a clinical record without breaking glass, and should not need to for this.
- **Alex, therapist.** Sometimes takes their own calls, and wants to see who has asked for them by name before front desk assigns anyone.
- **Priya, auditor.** Must be able to see that an inquiry existed, was handled, and was purged — without the purge being something she has to take on faith, and without ever learning who it was.

## User Stories (priority order)

1. As **Dana**, I record a call with a name, a phone number, what they asked for, and how they heard of us — without inventing a DOB.
2. As **Dana**, I put a caller on the waitlist for Tuesday evenings before they are a client, because Tuesday evenings are exactly what we do not have.
3. As **Dana**, I mark an inquiry dead with a reason code when the third callback goes unanswered.
4. As **Dana**, I convert an inquiry into a client in one step when they book, and the intake packet goes out on the same click.
5. As **Ray**, I see referral mix and call-to-first-session time without opening anybody's record.
6. As **Alex**, I see the two people who rang asking for me, before front desk decides where they go.
7. As **Priya**, I see that inquiry `cl…` was created, discarded and purged, and I cannot tell from the log who they were.

## Requirements

### Must-Have (P0)

**P0-1: `Inquiry` is its own model, not a `Client` with nulls** *(the decision the rest of this PRD hangs on)*

- New table. Fields: caller `firstName`/`lastName`, `phone?`, `email?`, `requestedClinicianId?`, `referralSource`, `referralNote?`, `note?` (operational free text, front-desk tier — same tier as `WaitlistEntry.note`), `status`, `createdAt`, `takenById`.
- **No `dateOfBirth`, no `code`, no `treatingClinicianId`.** Those three are what conversion is *for*.
- Deliberately absent, and enforced by there being no column: any relation to `ProgressNote`, `ProcessNote`, `FormRequest`, `FormSubmission`, `Alert`, `Appointment`, `PortalLink`, `OutboxMessage`. A test greps `src/` and `app/` for an `inquiry` reference inside those modules and fails the build, in the style of `notes/service.test.ts`.
- The alternative — nullable `Client.dateOfBirth`/`treatingClinicianId` plus a `ClientStatus.inquiry` — reuses the waitlist, forms, outbox and portal for free. It is rejected because it requires introducing a `deleteClient` path into a codebase where `Client` is the FK root of every clinical table. See D-01.

**P0-2: Three states, and the transitions go through a state machine**

- `open → converted` and `open → discarded`. Both terminal. Nothing returns to `open`.
- Lives in `src/clients/inquiry.ts` with a `TRANSITIONS` table in the shape of `scheduling/lifecycle.ts`, per hard rule 8. A wrong transition is a `Conflict`, not a silent no-op.
- `discardedAt` is set on discard and is what the retention window counts from.

**P0-3: Discard carries a reason code, never free text**

- `InquiryDiscardReason`: `no_answer`, `not_a_fit`, `referred_out`, `no_capacity`, `chose_elsewhere`, `duplicate`, `spam`.
- Codes, in the idiom of `FeeWaiveReason` and `RescheduleReason`, for the same reason: this value reaches the audit log, and the audit log is read by the one role that may not open a record.

**P0-4: `discard` is its own action in the permission matrix** *(core learning artifact)*

- `Action` gains `'discard'`. `Resource` gains `'inquiry'`.
- Not `update`, and deliberately not `delete`: `permissions.ts` already argues that a power nobody named is a power nobody reviewed, and that is why `waive` is not an `update` on `fee`. `delete` as a *generic* action would be a verb reviewers would later reach for on a table that must never lose a row. `discard` applies to exactly one resource and reads wrong anywhere else.
- Matrix rows:

  | role | inquiry |
  |---|---|
  | front_desk | `read: always`, `create: always`, `update: always`, `discard: always` |
  | therapist / associate / supervisor | `read: always`, `create: always` |
  | admin | `read: always`, `create: always`, `update: always`, `discard: always` |
  | auditor | — (audit_log only, as today) |
  | client | — |

  Clinicians read and create because a therapist who takes their own call should be able to write it down, and because an inquiry naming a requested clinician is a capacity question that clinician answers. They do not discard: recording a call is clerical, declaring one dead is an operations decision. **Break-glass does not appear** — there is nothing clinical here to reach.

**P0-5: The purge, and what the database refuses** *(core learning artifact)*

- A clock-driven sweep deletes inquiries where `status = 'discarded'` and `discardedAt` is older than `PracticeSettings.inquiryRetentionDays` (default 90).
- Two-step on purpose. An immediate hard delete makes a mis-click at 9am unrecoverable when they ring back at 2pm; a soft delete that never completes is the thing this PRD exists to refuse.
- **A database trigger refuses any `DELETE` of an inquiry that is not `discarded`.** This is the codebase's first deletion rule and it is written the same way as its immutability rules — `audit_append_only`, `progress_note_content_frozen` — because hard rule 5's principle generalises: an invariant that matters is enforced by the database, not by convention. The *window* stays application policy; the *invariant* does not.
- `WaitlistEntry.inquiryId` is `ON DELETE CASCADE`. A waitlist entry for a person who no longer exists is not a thing. Every other relation to `Inquiry` is `ON DELETE RESTRICT` and there are none, by P0-1.
- A converted inquiry is never purgeable: it is now part of a client's history, and the trigger already refuses it.

**P0-6: What the audit log keeps, and what it deliberately loses**

- Create, read-list, update, convert, discard and purge all write audit rows through the existing guard, in the same transaction as the work (hard rule 4).
- Rows carry `resource: 'inquiry'`, `resourceId: <inquiry id>`, and **`clientId: null`** — that column means *a client record*, and an inquiry is not one. After conversion, rows about the resulting client carry the client id as normal.
- The purge writes one row per inquiry, actor `system`, action `discard`, `reason: 'purged'`. Discards carry `reason: 'discarded:<code>'`.
- **After the purge, `resourceId` names a row that no longer exists, and that is the correct end state.** The log says an inquiry was created, was handled, and was destroyed. It never said who it was — `AuditEvent.clientId` has no foreign key and inquiry ids never enter it, so nothing dangles and nothing needs a cascade. An auditor sees the shape of the event and not the person, which is precisely what purging is *for*. The alternative — blocking the delete to keep the log joinable — is how "deletable" quietly becomes "undeletable".

**P0-7: The waitlist accepts an inquiry**

- `WaitlistEntry.clientId` becomes nullable; `inquiryId` is added; a `CHECK` constraint requires exactly one.
- `fits()` is unchanged — it already reads only weekday and window. `ENTRY_SELECT` gains the inquiry branch, and `waitlistOpenings`' "never offer a client the hour they just gave back" comparison skips inquiry entries, which by construction gave nothing back.
- The worklist labels an inquiry entry as an inquiry: no client code, no treating clinician, because there is neither. Front desk is ringing a stranger, and the screen should say so.
- This is the one place the inquiry stage earns a nullable FK, and it earns it because "wants a slot we do not have" is the *reason* most inquiries stay inquiries.

**P0-8: Conversion**

- `convertInquiry(actor, id, { code, dateOfBirth, treatingClinicianId, ...clientFields })`, in one transaction via `guardedAll`: create the `Client`, set `Inquiry.clientId` and `status = 'converted'`, repoint any waitlist entry from the inquiry to the client, copy `referralSource`/`referralNote` onto the client.
- Sending the intake packet is the caller's next step, not a hidden side effect of conversion — `issueForm` already refuses a template the client cannot read in their language, and that refusal must surface to the person who clicked, not get swallowed inside a conversion.
- The inquiry row is retained. It is what makes "how long from call to first session" answerable.

**P0-9: `referralSource` on `Client`, and the two tiers of the same fact** *(core learning artifact)*

- `ReferralSource` enum on both `Inquiry` and `Client`, plus `referralNote String?`. Clients created directly — walk-ins, the seeded ninety-seven — get it too, or the report has a hole shaped like the practice's own history.
- **The enum values are exactly the `referral` options in `intakeForm`** (`gp`, `friend`, `search`, `other`), and a test asserts the two lists match. Options in a form template are data and change without a deploy; this enum is schema and does not. Without the test they drift, and the drift is invisible until a report has a category the form cannot produce.
- The duplication with the form answer is the point, not an oversight: the form answer is a `FormSubmission` guarded at `treatingOrSupervising`, and the practice manager who runs the referral report may not read it. Same fact, two sensitivity tiers, two readings — the same argument `clients/repository.ts` already makes about one client row read as demographics and as clinical record.

### Nice-to-Have (P1)

- **P1-1: Referral mix and time-to-conversion report** — a table on the existing reports page: inquiries by source, conversion rate, median days from `createdAt` to first completed appointment. Front desk and admin. It is the only reason `referralSource` exists.
- **P1-2: Duplicate warning on create** — matching phone or email against existing `Client` rows surfaces "we may already know this person" with a client code and nothing else. A warning, never a block, and never a clinical fact.
- **P1-3: Inquiry age on the worklist** — open inquiries older than N days alongside the continuity queue. An unreturned call is the same category of failure as a client with nothing booked.
- **P1-4: Purge preview** — what the next sweep will destroy, so the window is visible before it fires rather than after.

### Future Considerations (P2)

- [ ] A public inquiry form that writes an `Inquiry` directly (needs rate limiting and spam handling before it is anything but a liability)
- [ ] Inquiry assignment to a clinician's own queue, with capacity signalling
- [ ] Referral-source detail for `gp` and `referred_out` — which practice, which doctor — which turns a code into an entity and wants its own model
- [x] Retention windows per discard reason (`spam` at 7 days, `referred_out` at 365) — `spamRetentionDays`/`referredOutRetentionDays` on `PracticeSettings`, same override pattern as `inquiryRetentionDays`; every other reason still ages out on the general window.

## Success Metrics (evaluated against synthetic seeded data)

**Leading**
- Permission matrix: every `inquiry` cell asserted including all denials; `discard` denied to therapist, associate, supervisor, auditor and client, and each denial audit-logged
- The database trigger refuses `DELETE` on an `open` inquiry and on a `converted` one, asserted against a real connection, not mocked
- A purge sweep over a seeded set destroys exactly the discarded rows past the window, is idempotent across repeated runs, and leaves the audit rows intact
- `ReferralSource` enum values equal `intakeForm`'s `referral` options — asserted, not assumed
- Zero paths from an `Inquiry` to a form request, submission, note, alert or outbox row: grep test green
- State machine: every illegal transition raises `Conflict`

**Lagging (simulated)**
- A seeded quarter contains ~40 inquiries: ~20 converted, ~15 discarded across the reason codes, ~5 still open. The referral report matches hand-tallied fixtures.
- After a simulated 120-day clock advance, the discarded rows are gone and the auditor's inquiry timeline still shows create → discard → purge for each, with no name recoverable anywhere in the database.

## Decisions

- **D-01: `Inquiry` is a separate model, not `Client.status = 'inquiry'`.** The nullable-Client version reuses the waitlist, forms, outbox and portal for free, and would be the lazier answer to almost any other requirement. It fails on the one that matters: it requires a delete path aimed at the FK root of every clinical table in the schema. A separate model keeps `DELETE` pointed at a table that can only ever hold non-clinical rows, and lets a trigger say so.
- **D-02: `discard`, not `delete`, in the matrix.** One resource, one verb, reads wrong anywhere else. Follows `waive`.
- **D-03: Discard then purge, not immediate hard delete.** A recoverable window for a mis-click, and it makes the destruction clock-driven and therefore testable — which the injected clock already exists for.
- **D-04: The intake form's referral answer and `Client.referralSource` stay independent.** Surfacing the form answer to front desk to "keep them in sync" would leak a clinical submission to a role that cannot read one. Two tiers, and the report reads the tier its reader is allowed.
- **D-05: Nothing is ever sent to an inquiry.** No consent, no reminder preference, no language on file — and a message to a number somebody left on a voicemail is a disclosure to whoever else holds that phone.
- **D-06: The audit trail is allowed to point at a deleted row.** The log records that a thing happened, not a joinable copy of the thing. Keeping the join alive would mean keeping the person.

## Risks and objections

- **"You have built a way to delete records in a clinical system."** Yes, narrowly, and the narrowness is the feature: one table that by construction holds no clinical content, one status that permits it, one database trigger that refuses everything else. The risk of *not* having it is a permanent record of every person who rang once and never came back.
- **"90 days is wrong."** Almost certainly, somewhere. It is a settings field, the settings page says the number is a legal question, and P2 splits it per reason.
- **"Front-desk free text will end up holding clinical detail."** `Inquiry.note` will eventually contain something a caller said about why they are calling. This is the honest weak point. Mitigations: the field is labelled for scheduling preferences, the deny-list is not applicable (nothing is sent), and the purge is what limits the exposure window. A stronger version — structured fields only — was rejected as unusable for a person on a phone.
- **"Converted inquiries are undeletable, so half the callers are still permanent."** True and intended. They became clients.
- **The migration touches `WaitlistEntry`.** Existing rows all have `clientId`; the `CHECK` is satisfied on day one. Verify against seeded data before the nullable column lands, in the style of the localized-labels migration.

## Open Questions

- **(Product)** Should a clinician see inquiries that named a *different* clinician? V1: yes, `read: always` — a six-person practice discusses its caseload, and per-clinician filtering is a UI default, not a permission. Revisit if the matrix cell starts carrying weight it should not.
- **(Product)** Does `duplicate` as a discard reason want to record *which* record it duplicates? That is a client id on a row about to be destroyed. V1: no. The reason code is enough.
- **(Builder)** Does the purge run on the same scheduled path as the confirmation cadence, or its own? Prefer the existing one — a second scheduler is a second thing to forget.
- **(Builder)** Does the auditor UI need an inquiry filter, or does `resource = inquiry` on the existing filter cover it? Try the existing filter first.

## Timeline / Phasing

- **Phase 1:** P0-4 (matrix cells + every denial), P0-2 (state machine). Pure logic, TDD, per CLAUDE.md's ordering — the permission and transition tables shape everything after.
- **Phase 2:** P0-1, P0-3, P0-5 (schema, trigger, purge sweep), P0-6 (audit). The trigger is asserted against a real database or it is not asserted.
- **Phase 3:** P0-7 (waitlist), P0-8 (conversion), P0-9 (`referralSource` + the enum/fixture equality test).
- **Phase 4:** UI — `/inquiries`, the convert form, worklist labelling, settings field. Then P1.
- Capstone demo: front desk records a call, waitlists it for an hour the practice does not have, discards it three callbacks later, the clock advances past the window, and the auditor is left with a timeline that proves someone was handled and cannot say who.

## Build Notes for Claude Code

- All CLAUDE.md hard rules apply unchanged. The two that bite here: authorization only through `permissions.ts` (both new matrix entries, no ad-hoc checks), and state transitions only through the state machine module.
- Adding `'discard'` to `Action` and `'inquiry'` to `Resource` will fail `permissions.test.ts`'s matrix coverage until every role × action cell is asserted, including the denials. That is the test doing its job — fill the cells, do not narrow the test.
- The trigger goes in the migration, not in Prisma. Name it in the same register as `audit_append_only`: `inquiry_delete_only_discarded`.
- Write WRITEUP §18 as this lands, not after. The entry is the deletion design: what makes the row deletable, what the database refuses, and what the audit log gives up on purpose.
