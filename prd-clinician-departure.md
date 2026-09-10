# PRD: Clinician Departure — the caseload transfer, and the note nobody may sign

**Sample business:** "Stillwater Counseling" (as in the parent PRD) — 6 clinicians, 4 rooms, ~70 standing weekly clients
**Builder:** Solo, in Claude Code
**Status:** Draft v1.0 — feature PRD, child of `prd-clearpath-counseling-ops.md`. Sibling of `prd-intake-inquiry.md` and `prd-appointment-confirmation.md`
**Learning objectives:** what "author-only" and "append-only" mean on the day the author leaves, in a codebase whose two strongest rules are both keyed to a person; a bulk move across five tables whose failure mode is a *half-moved* caseload, validated against a database exclusion constraint before it runs rather than during; and a widening of clinical read access that has to be a reviewed decision rather than a quiet one

---

## ⚠️ Scope Honesty (read first)

This is a **learning project with synthetic data only**. Nothing here rings anybody and nothing here files anything with a licensing board. It applies HIPAA-*inspired* design principles — least-privilege access, honest audit trails, no PHI in messages, URLs or logs — because they are excellent engineering discipline. It is **not** HIPAA-compliant software and must never hold real client data.

Two honesty notes specific to this feature:

**What happens to a departing clinician's private process notes is a professional and jurisdictional question, not an engineering one.** In several jurisdictions psychotherapy notes are the clinician's own work product and leave with them; in others they belong to the practice; in others still nobody has ever tested it. This PRD designs a mechanism with a configurable window and a database rule that keeps the destruction narrow. It does not claim any number is the right one anywhere, and the settings page says so — in the same register as `inquiryRetentionDays`.

**Telling a client their therapist is leaving is clinical work, not a mail merge.** P1-3 designs a *scheduling* message, saying who they are seeing from which date. The conversation about ending a therapeutic relationship happens in a room, and nothing in this PRD should be read as automating it.

## Problem Statement

Alex, a therapist, gives four weeks' notice on the 1st. On the 30th they stop. Between those two dates Stillwater has to move fifteen standing weekly clients onto colleagues who mostly do not have a free Tuesday at six, decide which of those clients are transferring at all, and close out a body of clinical work that only Alex is permitted to touch.

**What Clearpath can do about this today, accurately: `User.active = false`.**

That flag does two things and no others. `session.ts:45` returns `null`, so Alex cannot log in. `session.ts:69` filters them out of the person picker. Everything else in the database still points at a working clinician:

- **Fifteen `Client` rows still hold `treatingClinicianId = alex`.** `treatingOrSupervising` is the rule behind `client`, `fee`, `attendance_history` and `form_submission`, so the colleague now seeing that client on Tuesday can read none of it, and Alex — the only actor for whom the rule is true — cannot log in. The caseload is not orphaned; it is *held* by somebody who is gone.
- **`AppointmentSeries.active` is still `true`,** so recurrence keeps expanding Tuesday 18:00 across the horizon into a calendar with nobody in the chair, and `appointment_clinician_no_overlap` keeps defending that empty hour against anybody else booking it.
- **Draft progress notes cannot ever be signed.** `progress_note.sign` is `author`. There is no second holder, by design — a supervisor countersigns the record, they do not author into somebody else's. Every unsigned draft Alex leaves is permanently incomplete.
- **Process notes cannot ever be read.** `process_note.read` is `author`, and admin has *no entry at all* — break-glass does not reach them, deliberately. The moment Alex's account is deactivated there is no living actor for whom `isAuthor` is true, and the most sensitive content in the database becomes reachable only through `psql`.
- **Unacknowledged alerts have no reader.** `alert.read` is `recipient`, singular, per hard rule 9. A `screener_critical_item` addressed to Alex on the 29th is a risk signal that now nobody will ever see.
- **Their books stay open.** `capacity.update` is `self` and admin holds `read` only — D-09 of the intake PRD named this exact cost in writing: *"a clinician on leave with their books left open is a wrong signal nobody else can correct."*
- **The `User` row can never be deleted,** and should not be: six tables reference it `ON DELETE RESTRICT`, and the audit rows naming Alex as actor must stay exactly as written.

None of that is a bug. Each one is a rule this project argued for and got right. Departure is simply the first event that asks all of them the same question at once — *and now?* — and the honest answer today is that nobody has asked.

## Goals

1. A departure is **one act with a date**, planned on notice and executed on the last day, not fifteen edits somebody remembers to make.
2. Every client on the leaving caseload has an explicit **disposition** before the departure can execute — transferred to a named colleague, discharged, or referred out. There is no default and no silent remainder.
3. The transfer moves **access, future sessions and supervision together, in one transaction**. A departure that fails halfway moves nothing.
4. The clinician now carrying a client can **read that client's official record**, including what the previous clinician wrote — and this is a named widening with a decision behind it, not a quiet one.
5. The **private process notes never transfer to anybody**, and the fact that nobody can ever read them again is answered explicitly rather than left as dead rows.
6. The unsignable draft is **prevented first and admitted second**: the departing clinician is shown their own unsigned work while they can still sign it, and what remains is marked as what it is.
7. The audit log is unchanged in every respect except that it gains rows. Nothing Alex did stops being true.

## Non-Goals

- **Authorship never transfers.** No mechanism, at any priority, ever, assigns an existing note to a different author. The official record asserts that a named person wrote something on a date, and a system that can retarget that assertion has no official record — it has a mutable document with a byline. This is the non-goal the rest of the PRD is shaped around.
- **No deleting a `User` row.** Six `RESTRICT`s already say so and this feature adds nothing that argues with them. A person who worked here is a permanent fact about the audit trail.
- **No leave of absence.** A departure is terminal and one-way; coverage for somebody coming back in eight weeks is a second, reversible state machine with a different answer to every question in this document (their process notes do *not* age out, their notes stay signable, their books reopen). Deliberately deferred to P2 rather than smuggled in as a `Departure` with a null `lastDayOn`.
- **No export of the departing clinician's records.** "The therapist takes their process notes with them" is a real professional norm and it is a *disclosure*, which is a records-release feature with a consent scope, a point-in-time snapshot and a disclosure-accounting audit event. It is a sibling PRD, not a P2 bullet on this one. Where the two would meet is named in Open Questions.
- **No re-consent workflow.** A client must be told their therapist is leaving and may choose to go elsewhere. The `discharge` and `referred_out` dispositions model the *outcome* of that conversation. The conversation is not software.
- **No payroll, HR, offboarding checklists, or account deprovisioning beyond `active = false`.** There is no authentication in Clearpath (WRITEUP §9); there is nothing to deprovision.
- **No backdating.** A departure cannot be recorded with a `lastDayOn` in the past. The whole mechanism is a plan with time to be validated in, and a same-day departure is the one case it cannot help with — see Risks.

## Personas

- **Ray, practice manager (admin).** Receives the notice. Owns the plan, owns who receives which client, owns pressing the button on the last day. Cannot read a clinical record to make those decisions and must not need to.
- **Alex, therapist (departing).** Wants to leave their caseload in a defensible state: notes signed, colleagues briefed, nothing left half-written with their name on it.
- **Beth, therapist (receiving).** Inherits four of Alex's clients. Needs the official record for a client she is now clinically responsible for, on the day she becomes responsible, not after a support ticket.
- **Sam, supervisor.** Supervises the pre-licensed associate. If *Sam* is the one leaving, the associate's co-signature queue has to land somewhere, and the notes Sam already co-signed keep Sam's name on them.
- **Dana, front desk.** Must stop booking new work into a departing clinician the day notice is given, and must be able to tell a caller who they will be seeing.
- **Priya, auditor.** Must see that a caseload moved, when, by whom, and to whom, without any of it telling her anything clinical.

## User Stories (priority order)

1. As **Ray**, I record that Alex is leaving on the 30th, and the practice stops offering Alex to new callers that afternoon.
2. As **Ray**, I see Alex's fifteen clients as a work-list where each one needs a decision, and the departure will not execute while one is undecided.
3. As **Ray**, I see which of my proposed transfers will collide with the receiving clinician's existing hours *while there is still time to move them*, not on the last day.
4. As **Alex**, I see my own unsigned drafts, oldest first, with the number of days left, so I can sign them before I go.
5. As **Beth**, on the 1st, I open my new client's record and read the history — including the notes Alex wrote — because I am now the clinician responsible for what happens next.
6. As **Sam**, my supervisee's signed notes appear in the new supervisor's queue the moment supervision re-points, and the notes I already co-signed still say I co-signed them.
7. As **Priya**, I see one departure, fifteen dispositions, and every note that was abandoned — and I cannot tell from any of it what any of those clients came in for.

## Requirements

### Must-Have (P0)

**P0-1: `Departure` is a plan before it is an event, and there is a row per client**

- `Departure`: `userId`, `noticeAt`, `lastDayOn` (`@db.Date`), `status`, `plannedById`, `executedAt?`. A partial unique index gives one non-terminal departure per user — a person may leave twice in a career, but not twice at once.
- `DepartureAssignment`: `departureId`, `clientId`, `disposition`, `receivingClinicianId?`, `referredOutToId?`, `decidedById`, `decidedAt`. Unique on `(departureId, clientId)`.
- `DepartureDisposition`: `transfer`, `discharge`, `referred_out`. Codes, in the idiom of `FeeWaiveReason` and `InquiryDiscardReason`, and for the same reason: this value reaches the audit log, and the audit log is read by the one role that may not open a record.
- `referred_out` reuses **`Referrer`** — the same table the intake PRD's D-11 argued should serve both directions. A client leaving to a practice down the road and a caller arriving from it are the same relationship, and this is the second direction that argument promised.
- Rejected: a single `receivingClinicianId` on `Departure`. Real caseloads split — some clients follow the clinical fit, some follow the hour, some end. One column would have made the common case one field and the real case impossible.

**P0-2: Three states, and the transitions go through a state machine**

- `planned → executed` and `planned → cancelled`. Both terminal; nothing returns to `planned`. Notice gets withdrawn often enough that `cancelled` is not a hypothetical.
- `TRANSITIONS` table in `src/staff/departure.ts`, shaped exactly like `scheduling/lifecycle.ts`, per hard rule 8. A wrong transition is a `Conflict`, not a silent no-op.
- `cancelled` reverses the notice-time effects of P0-9 and nothing else, because nothing else has happened yet. This is the entire reason execution is a separate act from planning.

**P0-3: `depart` is its own action on a new `departure` resource** *(core learning artifact)*

- `Action` gains `'depart'`. `Resource` gains `'departure'`.
- Deliberately not `user: { update: … }`, which admin already holds. That cell is roles and supervision relationships; this one deactivates an account, moves fifteen clinical records to new readers, closes a body of notes and destroys another. Same button, three orders of magnitude more blast radius — and this file's whole argument is that **a power nobody named is a power nobody reviewed**. It follows `waive` and `discard` exactly.
- Matrix rows:

  | role | departure |
  |---|---|
  | admin | `read: always`, `create: always`, `update: always`, `depart: always` |
  | front_desk | `read: always` |
  | supervisor | `read: always`, `update: always` |
  | therapist / associate | `read: self` |
  | auditor | — (`audit_log` only, as today) |
  | client / public | — |

  Front desk reads because they answer the phone to "who will I be seeing?" and must stop booking; they hold nothing else, because who receives a caseload is a clinical-fit judgement. A supervisor holds `update` — proposing who takes which client is exactly the judgement supervision exists for — but not `depart`, because executing it deactivates an account and that is the practice manager's act. Clinicians read `self` and nothing more: your own departure is a thing you are entitled to see recorded correctly, and `self` is the rule that already means "this row is about you and has no meaning apart from you". **Break-glass appears nowhere in this row** — a departure plan holds a client list, and a client list at the demographic tier is something admin already reads.

**P0-4a: The unsigned-drafts list, shown to the person who can still sign them** *(the half that prevents the problem)*

- A read-only list on the departing clinician's own screen: their `ProgressNote` rows at `status = 'draft'`, oldest first, with days remaining until `lastDayOn`. Straight off the existing `@@index([authorId, status])`; no new column, no new permission — `read: 'authorOrSupervisor'` already covers a clinician reading their own drafts.
- This is listed before P0-4b on purpose. A design whose only answer to "the note nobody may sign" is a status change has accepted the loss; most drafts get signed if somebody shows the clinician the list while they are still here.

**P0-4b: The draft that is left behind becomes `abandoned`, and `sign: 'author'` does not move** *(core learning artifact)*

- `ProgressNoteStatus` gains `abandoned`. The departure transaction sets it on every `draft` note authored by the departing clinician, with `abandonedByDepartureId` naming why.
- **`sign` stays `author`. Nothing gains it — not the receiving clinician, not the supervisor, not break-glass.** Letting Beth sign Alex's draft would make the official record assert that a clinical judgement was made and attested by someone who was not in the room. A record that can say that is worth less than a record with a hole in it, because the hole is visible and the false attestation is not.
- `abandoned` is terminal and reachable only from `draft` — a signed note is already the record and is frozen by `progress_note_content_frozen`. It is added to the same `TRANSITIONS` discipline the note status already follows.
- The content is **retained**, not destroyed. It is clinical work product about a session that happened, and it stays readable at exactly the tier a draft was already readable at. Nobody gains anything; the row stops pretending it is on its way somewhere.
- What this costs, stated plainly: a client's record contains a session with no signed note, permanently, and the practice's own reporting has to be able to say how many. That number is the honest measure of how well P0-4a worked.

**P0-5: The official record follows the client; the private notes never do** *(core learning artifact — the reason this PRD is worth building)*

- Today `progress_note.read` is `authorOrSupervisor`. That is coherent for as long as a client's clinician never changes, and departure is the first thing in this codebase that changes one. On the 1st, Beth is clinically responsible for a client whose entire written history she is denied.
- The anomaly is already visible without departure: `form_submission` — screener answers and risk scores, which is clinical data by any reading — is `treatingOrSupervising`, and so are `client`, `fee` and `attendance_history`. **`progress_note` is the only clinical resource on a client's record that is narrower than the record around it.** The official record is the one thing a treating clinician cannot read.
- So `progress_note.read` becomes a rule that is the union of the two: the author who wrote it, the supervisor responsible for that author, and the clinician who carries the client now. A new `RULES` entry — working name `recordReader`, see Open Questions — rather than a widening of `authorOrSupervisor`, so that the change is one named cell in the matrix and `permissions.test.ts` makes every new grant an asserted one.
- **`process_note` does not move, in any way, at any priority.** `read: 'author'`; admin still has no entry; break-glass still does not reach it. This is the psychotherapy-notes distinction that the whole project exists to demonstrate, and the departure is what makes it *visible*: the record transfers because it is the practice's record of care, and the private notes do not because they were never part of it. One event, two opposite answers, and the reason is the same sentence in both directions.
- Consequence to state and to test: the widening is not scoped to transferred clients. Any clinician reads the progress notes of any client they treat, whoever wrote them. That is the correct rule and it is also strictly more access than yesterday, granted to every clinician at once by a migration — which is exactly why it is a decision with a number on it (D-04) and not a helpful tweak inside the transfer.

**P0-6: The transfer, in one transaction, validated before it runs** *(core learning artifact)*

- `executeDeparture(actor, departureId)` — `guardedAll`, one transaction, everything or nothing:
  - each `transfer` assignment: `Client.treatingClinicianId = receivingClinicianId`;
  - each `discharge`: `Client.status = 'inactive'`; each `referred_out`: same, plus the `Referrer` recorded on the assignment;
  - future non-terminal `Appointment` rows (`start >= lastDayOn`) repoint `clinicianId`, or cancel where the disposition is not `transfer`;
  - `AppointmentSeries` repoints `clinicianId`, or `active = false`;
  - supervisees' `User.supervisorId` repoints (P0-8);
  - unacknowledged `Alert` rows repoint (P0-7);
  - remaining `draft` notes become `abandoned` (P0-4b);
  - process notes are marked unreachable (P0-10);
  - `User.active = false`.
- **The transfer cannot be a blind `updateMany`, and the reason is a database constraint.** Fifteen clients moving to three colleagues means fifteen appointment rows landing on clinicians who already have hours, and `appointment_clinician_no_overlap` is a Postgres exclusion constraint that will refuse the clash. So a plan is *validated* while there is time to fix it: `departureConflicts(departureId)` answers the same overlap question the booker already answers, over every future occurrence the plan would move, and the plan screen lists every clash with the hour, the client and the colleague it collides with.
- At execution, a clash is a `Conflict` that **rolls back the entire departure**. A partially moved caseload — some clients with a new clinician, some with a deactivated one, a supervision tree half re-pointed — is the single worst state this feature could produce, and it is worse than not executing. The plan had thirty days to be right, and the validation ran on every one of them.
- Rejected: moving what fits and leaving the clashes on a work-list. It optimises the last day at the cost of the invariant, and "which of my clients actually moved?" becomes a question answered by inspection.

**P0-7: The alert with no reader** *(small, and it shows the rule holding rather than bending)*

- Unacknowledged `Alert` rows addressed to the departing clinician repoint `recipientId` to the receiving clinician for that client. Hard rule 9 is untouched: the alert still routes to exactly one treating clinician, never a shared inbox, never front desk.
- **Acknowledged alerts do not move.** "Alex saw this on the 12th" is a fact about the 12th, and re-pointing it would overwrite the only evidence that the signal was ever received.
- A client with disposition `discharge` or `referred_out` has no receiving clinician; their unacknowledged alerts route to the departing clinician's supervisor if there is one, and otherwise raise on the departure plan itself as a blocking item. An unread risk alert is not something a departure gets to close over.

**P0-8: The departing supervisor**

- Supervisees' `User.supervisorId` repoints to the receiving supervisor named on the departure. The schema comment on that field already promises this works with no deploy — co-signature routing and progress-note read access both follow `supervisorOfAuthor` and `authorSupervisorId`, resolved at read time — and this is the feature that finally exercises the promise.
- **`ProgressNote.coSignedById` changes from `ON DELETE SET NULL` to `ON DELETE RESTRICT`.** A co-signature is an assertion made by a named person on a date; a foreign key that can quietly null it describes a record that can lose its second signer. This changes nothing today — the `User` row is already undeletable six ways — and that is precisely the point: it makes the schema say what the system means.
- A supervisor leaving with an associate's notes awaiting co-signature is a real problem with no clean answer, and the honest one is that the incoming supervisor co-signs work they did not supervise, with their own name and date on it. See Risks.

**P0-9: Notice closes the books; execution closes the account** *(and this resolves a cost the intake PRD wrote down)*

- On `departure.create`: `User.acceptingNewClients = false`, and the clinician is marked departing in the person picker with their last day. On `departure.depart`: `User.active = false`.
- Two moments, two effects, and the gap between them is the thirty days the practice needs. Front desk stops offering Alex to a new caller the afternoon notice is given; Alex keeps working, keeps signing notes, keeps their calendar until the 30th.
- **This is the narrow, named path that answers D-09's stated cost.** Admin still does not hold `capacity.update` and still cannot mark a clinician *open* — the argument that a manager who can do that has turned the signal from "what this clinician can carry" into "what the practice would like" is unchanged and unweakened. What `departure.create` grants is the ability to close a clinician's books as a side effect of recording a dated fact about their employment, and closing is the only direction it goes. `departure.cancelled` restores `acceptingNewClients` to its value at notice, because the fact it was derived from stopped being true.

**P0-10: The process notes nobody can reach, and the window that ends them**

- On execution, every `ProcessNote` authored by the departing clinician gets `unreachableSince`. Nothing about the permission changes: `read: 'author'` was already true and is already unsatisfiable, and this column records *when* that became true rather than granting anybody anything.
- A clock-driven sweep destroys them once `unreachableSince` is older than `PracticeSettings.processNoteAfterDepartureDays`. There is no default the PRD is willing to defend; the field ships with a long one, the settings page says the number is a professional and jurisdictional question, and the honesty note at the top of this document says it again.
- Two-step, exactly as the intake purge is, and for the same reasons: a mis-executed departure on Tuesday is recoverable on Wednesday, and a destruction driven by the injected clock is a destruction that can be tested.
- **A database trigger refuses any `DELETE` of a process note whose `unreachableSince` is null.** `process_note_delete_only_after_departure`, in the same register as `audit_append_only`, `progress_note_content_frozen` and `inquiry_delete_only_discarded`. Hard rule 5's principle generalises: the *window* is application policy, the *invariant* is not.
- `NoteAmendment.processNoteId` is already `ON DELETE SET NULL`; an amendment to a destroyed note is an orphan carrying its own `content`, so the sweep deletes the amendments in the same statement rather than leaving the text behind the row it belonged to. This is the one place the existing `SetNull` would have quietly defeated the destruction.
- Rejected: leaving the rows forever. "Unreachable through the application" is not "unreachable", it is a growing store of the most sensitive content in the database with no reader and no end date, and the intake PRD already made this argument about a far less sensitive table.
- Rejected: destroying them on the last day. In several jurisdictions those notes are the clinician's own defence in a complaint made two years later, and a system that destroys them on the way out of the door has made that choice for them.

**P0-11: What the audit log gains, and what it does not lose**

- Every write above is audit-logged in the same transaction as the action, per hard rule 4: one row for the departure, one per assignment decided, one per client transferred, one per note abandoned, one per alert repointed, one for the deactivation, one per process note destroyed by the sweep.
- Rows carry `resource: 'departure'` and `resourceId: <departure id>`; rows about a specific client also carry `clientId`, because a transfer *is* an event on a client record. The disposition travels as `reason: 'departure:<disposition>'` — a code, never free text.
- **Nothing about the departing clinician's existing audit rows changes.** They are append-only and they name an actor who no longer works here, which is the correct and permanent state. A small assertion is owed here: the auditor's view must render an inactive actor's name — a join that filters `active: true` anywhere in the audit path would silently blank the trail of exactly the person most likely to be under review.
- The sweep's actor is the named `system` actor, following D-11 of the confirmation PRD: attributing an automatic destruction to a person is a false statement about who decided.

### Nice-to-Have (P1)

- **P1-1: The departure work-list.** Undecided clients, hour clashes, unacknowledged alerts with no receiver, and unsigned drafts with a countdown — one screen, in the shape of the existing `worklists.ts` page, that is the answer to "is this departure ready?"
- **P1-2: Continuity marker on the client record.** "Transferred from Alex Rivera to Beth Okoro, 30 Sept" at the demographic tier, so front desk can answer the phone. Names and a date, no clinical content, no reason.
- **P1-3: The scheduling message.** Through the existing `OutboxMessage` stub and the existing deny-list: *"From 1 October your appointments are with Beth Okoro. Same time, same day."* Schedule information the portal already discloses, in the client's own `language`, and it says nothing about why. Suppressed entirely for `reminderPreference = 'none'`, for the reason D-01 of the confirmation PRD gives.
- **P1-4: Abandoned-note count on the practice report.** How many sessions ended up with no signed note, by departure. It is the only honest measure of whether P0-4a is working, and a practice that cannot see the number will not fix it.
- **P1-5: Purge preview for the process-note sweep.** What the next run will destroy and when — the window made visible before it fires, following the intake PRD's P1-4.

### Future Considerations (P2)

- **Leave of absence** — a reversible coverage state with its own transitions: notes stay signable, process notes have no window, books close and reopen, and the covering clinician's access ends on a date. Everything this PRD makes terminal, that one has to make temporary, which is why it is not a flag on this model.
- **Records release / disclosure** — the departing clinician's own copy, a client's request for their file, a request from another practice. Consent with a scope and an expiry, a point-in-time snapshot that is reproducible later, and disclosure as an audit event distinct from a read. Its own PRD.
- **Transfer outside a departure** — a client who changes clinician for fit rather than because anybody is leaving. P0-5 already makes the access correct for this case; what it lacks is the act, the audit reason and the client's part in it.
- **A returning clinician** — rehired eighteen months later. Their old client relationships are gone and should stay gone; the question is whether their `User` row is reused and what that means for a supervision tree that has moved on twice.

## Success Metrics (evaluated against synthetic seeded data)

**Leading**
- Permission matrix: every `departure` cell asserted including all denials — `depart` denied to front desk, supervisor, therapist, associate, auditor and client, each denial audit-logged; `read: self` denies a clinician another clinician's departure
- `progress_note.read` asserted for all four claimants and their denials: author yes, supervisor-of-author yes, current treating clinician yes, an unrelated clinician no, admin still only under break-glass, front desk still never
- `process_note.read` unchanged under every departure state — the departed author's notes are denied to the receiving clinician, the supervisor, admin, and admin *with* break-glass. Four denials, asserted, because this is the rule the project is about
- `sign` on an `abandoned` note raises `Conflict`; `sign` on a departed author's `draft` is denied to every actor including the receiving clinician
- The database trigger refuses `DELETE` on a process note with `unreachableSince` null, asserted against a real connection, not mocked
- A transfer whose appointments collide with the receiving clinician's existing hours raises `Conflict` and leaves **zero** rows changed across all five tables — asserted by comparing full table snapshots, not by spot-checking the client rows
- `departureConflicts` finds the same collision the booker's overlap check finds, on the same fixture
- State machine: every illegal departure transition raises `Conflict`

**Lagging (simulated)**
- Seeded departure: a therapist with 15 clients, 3 receiving colleagues, 2 discharges and 1 referred out, 4 unsigned drafts, 2 unacknowledged alerts, 1 hour clash planted deliberately. Fixing the clash makes the execution succeed; the pre-fix run changes nothing
- After execution and a simulated clock advance past the window, the departing clinician's process notes and their amendments are gone, the audit log still shows every access they ever made, the receiving clinicians read their new clients' full note history, and no actor anywhere in the system can read a line of what the departed clinician wrote privately

## Decisions

| # | Decision | Why |
|---|---|---|
| D-01 | Authorship never transfers, and `sign` stays `author` with no new holder | The official record's whole value is that it asserts a named person made a clinical judgement on a date. A mechanism that retargets that assertion — even once, even for a good operational reason — means the record no longer says what it appears to say, and no reader can tell which rows are affected. A visible hole is worth more than an invisible false attribution |
| D-02 | The abandoned draft is retained, not destroyed | It is clinical work product about a session that actually happened, and the client's record is more truthful with an unfinished note in it than with nothing. Destroying it would also be the one deletion in this PRD aimed at the *official* record, which is the table that must never lose a row |
| D-03 | Prevention is a P0, not a nice-to-have | A feature whose only answer to "nobody can sign this" is a new status has accepted the loss and built the paperwork for it. The list of a departing clinician's own drafts costs one query on an index that already exists, and it is the only thing here that reduces the number of holes rather than labelling them |
| D-04 | `progress_note.read` widens to include the treating clinician — as a named rule and a matrix change, not as a grant inside the transfer | Two things are true: a clinician responsible for a client must be able to read that client's record, and this widens clinical read access for every note in the database at once. Doing it in the matrix means `permissions.test.ts` forces every new grant to be asserted and every denial re-stated. Doing it as a transfer-time grant would have been narrower and worse — the answer to "who can read this note" would have moved out of the one file that is supposed to answer it |
| D-05 | `process_note` is untouched, and departure is what makes that visible | The record transfers because it is the practice's record of care; the private notes do not because they were never part of it. The same sentence produces both answers, which is the clearest demonstration of the psychotherapy-notes distinction this project has had — sharper than any denial test, because here the *opposite* rule is applied to the neighbouring table in the same transaction |
| D-06 | An hour clash rolls back the whole departure rather than moving what fits | A half-moved caseload is the worst state this feature can produce and it is silent: no error, no flag, just some clients with a deactivated clinician. All-or-nothing makes the failure loud on a day when somebody is still there to fix it, and the plan had thirty days of validation to be right |
| D-07 | Conflicts are validated continuously from notice, not checked at execution | `appointment_clinician_no_overlap` is a database exclusion constraint, so the clash is discoverable at any time by asking the same question the booker asks. Discovering it on the last day means discovering it when the only remaining options are bad ones |
| D-08 | `depart` is its own action, not `user.update` | Admin already holds `user.update` for roles and supervision. This act deactivates an account, moves fifteen clinical records to new readers, closes one body of notes and schedules the destruction of another. Following `waive` and `discard`: a power nobody named is a power nobody reviewed |
| D-09 | Notice closes the books; only execution closes the account | The signal front desk needs on day one is "stop booking new work here", and the account has to keep working for thirty more days. Two effects at two moments is the whole reason the plan and the event are separate rows |
| D-10 | `departure.create` may close a clinician's capacity, and nothing may open it | Intake's D-09 refused admin `capacity.update` because a manager who can mark a clinician *open* has replaced the clinician's judgement with the practice's preference. Closing is not the mirror of opening: it never overstates what somebody can carry, and here it is derived from a dated employment fact rather than typed as an opinion. The asymmetry is the decision |
| D-11 | Process notes get a window, not immediate destruction and not permanent retention | Destroying them on the last day takes away the clinician's own defence in a complaint made later; keeping them forever leaves the most sensitive content in the database with no reader, no end date and no reason. A configurable window with a database rule keeping the destruction narrow is exactly the shape intake's purge already proved out, and it is reused rather than reinvented |
| D-12 | `ProgressNote.coSignedById` becomes `RESTRICT` | It changes nothing today and that is the point: the schema should state that a co-signature cannot lose its signer, rather than describing a system that would quietly null one if the impossible happened |
| D-13 | A departure with an undecided client cannot execute | The alternative is a default — "everything unassigned goes to the supervisor" — which is how fifteen people get a new therapist because nobody read a screen. There is no correct default for who treats somebody |
| D-15 | The new read rule is called `authorSupervisorOrTreating`, not `recordReader` | Settled in Phase 1, as the Open Question asked. `recordReader` names a role and every other rule in the file names a relationship — and at a call site the only useful question is *who exactly*, which an enumeration answers and an abstraction hides. It is also the shape of the rule: three claimants, unioned, with no fourth able to arrive without renaming the thing |
| D-16 | Both retention sweeps share a runner and stay two functions | A second schedule is a second thing to forget, and the one that gets forgotten is the one whose job is to make data stop existing. Their windows, invariants and triggers have nothing in common, so collapsing the queries would be the coupling a shared runner exists to avoid |
| D-17 | `abandoned` is reachable only from `draft`, enforced in the trigger | Without that clause the status is a way to retire an inconvenient signature: mark a signed note abandoned and the record now denies an attestation that was made. Everything else here keeps a hole visible; this keeps the same status from making one |
| D-18 | `NoteAmendment.processNoteId` becomes `Cascade`, and append-only grows exactly one hole | An amendment carries its own `content`, so `SetNull` would have destroyed the note and kept the words — the one place the existing rule quietly defeated the destruction. The hole is stated as what it is: a child of an already-unreachable note, and nothing else |
| D-19 | The sweep logs with `auditEvent`, never `guarded` | No cell in the matrix lets anybody but the author touch a process note — `SYSTEM_ACTOR` and break-glass included — and inventing one so a sweep could use the front door is the widening this feature exists to refuse. A window expiring is not an actor exercising a power |
| D-14 | Unacknowledged alerts move; acknowledged ones never do | An unread risk signal needs a reader, and hard rule 9 says exactly one. An acknowledged alert is evidence that a named person saw something on a date, and re-pointing it would overwrite the only record that the signal ever landed |
| D-20 | One `departureBlockers` list replaces `departureConflicts` | Settled in Phase 3. P0-7 and P0-8 each add a blocking item of their own — an unread alert with nobody to receive it, associates with no supervisor to take them — alongside undecided clients, unavailable receivers and hour clashes. A plan screen asking four functions whether it is ready is a plan screen that will one day ask three. Ids only; the screen resolves names through the resources that guard them |
| D-21 | Execution is one `guarded` `depart` row plus an `auditEvent` per consequence, not `guardedAll` over the records touched | The matrix refuses the sketch: admin's `client.update` is `breakGlass`, and a departure has no break-glass cell by design. Granting admin `client.update` so the transfer could pass through the per-record door is the widening this feature refuses. `depart` is decided once; every row after it names the departure, the client where there is one, and a `departure:<code>` reason — P0-11's shape, and the same register D-19 set for the sweep |
| D-22 | At execution the exclusion constraint decides hour clashes; the blocker scan is the preview | `booking.ts` already paid for this lesson: a read-then-write check has a window, and a session booked onto the receiver inside it slips through. So the scan runs continuously from notice (D-07) using the same `tstzrange &&` the constraint uses, and at execution a `23P01` rolls back the whole departure (D-06) as a `Conflict('hour_clash')`. The other blockers are facts about the plan rather than races with a neighbour, and are checked inside the transaction before any write |
| D-23 | `Departure` stores `acceptingNewClientsAtNotice` and one `receivingSupervisorId`, and the receiver must be an active supervisor | Cancelling notice without the stored value would have to guess `true`, reopening a clinician who had closed their own books — the manager setting a capacity signal D-10 says they cannot set. One supervisor per departure because a supervision tree is not a caseload: associates who split across supervisors are a restructure to do deliberately with `user.update`. `supervises()` requires the supervisor role, so naming a therapist would leave every associate with a co-signature nobody can give; a CHECK refuses naming the leaver |

## Risks and objections

- **"You widened access to every progress note in the database."** Yes — to the clinician treating the client the note is about, which is the relationship the rest of the clinical matrix already uses for the client's demographics, fee, attendance history and screener answers. The note was the outlier. The widening is one cell, the test asserts all four claimants and all their denials, and the narrow rule that actually carries this project's argument — `process_note.read: 'author'` — is untouched and gets four new denial tests out of it.
- **"The incoming supervisor co-signs work they did not supervise."** True, and there is no clean answer. The alternatives are a note that stays incomplete forever, or a co-signature attributed to the supervisor who left, which is a false assertion of exactly the kind D-01 exists to prevent. The record says who signed and when, which is the honest version of a compromise. A practice's real mitigation is a handover conversation, and software should not pretend to replace it.
- **"A same-day departure — dismissal, illness, death — gets nothing from this."** Correct, and it is the case the mechanism is least able to help with, because the plan is the thing that makes it safe. What it does still give: one act, one transaction, an all-or-nothing move, and a `noticeAt` equal to `lastDayOn` that says in the data that there was no notice. The clash validation runs at execution with no time to act on it, and the departure fails until somebody moves an hour. That failure is correct and it will be inconvenient on the worst possible day.
- **"You built a way to destroy clinical records."** Narrowly: one table, one column that only a completed departure sets, one trigger refusing every other case, one configurable window that defaults long, and a preview of what the next run will take. The risk of *not* having it is a permanent and growing store of psychotherapy notes with no living reader — which is a worse answer to the same question, arrived at by writing no code.
- **"`recordReader` is a bad name."** Probably. See Open Questions; it is the weakest thing in this document and it names the most important new rule in it.
- **The migration touches `ProgressNote`, `ProcessNote`, `User`, `Client` and `PracticeSettings`.** All new columns are nullable or defaulted, and the `RESTRICT` change is a no-op against existing rows. Verify the enum addition against seeded data before it lands, in the style of the localized-labels migration.

## Open Questions

- ~~**(Builder)** What is the new read rule actually called?~~ **Settled in Phase 1: `authorSupervisorOrTreating`** (D-15). The clumsy enumeration, as this question predicted it would be. It reads at the call site — `read: 'authorSupervisorOrTreating'` — and it is the name that goes in the audit row, which is the second reason it says exactly who.
- **(Product)** Should a departing clinician still be able to *write* — new notes, new appointments — between notice and last day? V1: yes, everything except being offered to new callers. They are still working. Revisit if a dismissal scenario ever needs an immediate cut, which is a different act with a different name.
- **(Product)** Does a discharged client's future appointment get cancelled, or left for front desk to ring about? V1: cancelled, because the calendar must tell the truth and an hour nobody will attend is an hour another client could have. The outbound message is P1-3 and the phone call is not software.
- **(Product)** Should the *client* have any say recorded — "asked to follow Alex to their new practice"? That is close to a clinical fact about a person's preferences and it would sit in a plan admin reads. V1: no. `referred_out` plus a `Referrer` is as much as the row needs to hold.
- ~~**(Builder)** Does the process-note sweep run on the existing scheduled path with the inquiry purge and the confirmation cadence, or its own?~~ **Settled in Phase 2: one path, `npm run purge:run`** (D-16). There was no existing scheduled path to join — the inquiry purge was an exported function nothing called — so the shared runner is what Phase 2 built, and it takes both. They stay two functions with two windows, two invariants and two triggers; what is shared is the schedule, which is the thing that gets forgotten.
- **(Builder/Product)** Where do this PRD and the records-release PRD meet? A departing clinician wanting a copy of their own process notes is a disclosure with a consent scope and a snapshot, not a read — and it is the one request that would need to be served *before* this feature's window destroys them. The ordering matters if both get built.

## Timeline / Phasing

- **Phase 1:** P0-3 (matrix cells and every denial), P0-5's rule change with its four claimants and their denials, P0-2 (state machine). Pure logic, TDD, per CLAUDE.md's ordering — and the `process_note` denials belong in this phase too, because the point of the whole feature is that they still fail.
- ~~**Phase 2:**~~ **Landed.** P0-1 (schema), P0-4b (`abandoned` and its transition), P0-10 (`unreachableSince`, the trigger, the sweep), P0-11 (audit). The trigger is asserted against a real database or it is not asserted. Five constraints, two triggers, one partial index and one deletion rule; WRITEUP §30. The enum value needed its own migration — Postgres forbids using a newly added value in the transaction that added it, and Prisma wraps every migration in one.
- ~~**Phase 3:**~~ **Landed.** P0-6 (the transaction and the rollback assertion), P0-7 (alerts), P0-8 (supervision and the `RESTRICT` change), P0-9 (the two moments). One `guarded` `depart` row and an `auditEvent` per consequence, because admin's `client.update` is break-glass and a departure has none (D-21); hour clashes decided by the constraint, previewed by the scan (D-22); WRITEUP §31.
- **Phase 4:** UI — the plan screen with the conflict list, P0-4a's drafts list, the settings field. Then P1.
- Capstone demo: notice is given and the clinician disappears from new-caller assignment the same afternoon; the plan screen shows one Tuesday-evening clash and refuses to execute; the clash is moved; execution transfers eleven clients, discharges two, refers one out, abandons a draft, and repoints an unacknowledged alert — all on one transaction. Then the receiving clinician opens her new client's record and reads four years of Alex's progress notes; then she opens the process-note panel and is refused, and so is the practice manager, and so is the practice manager with break-glass. Then the clock advances past the window and those notes are not there for anybody to be refused.

## Build Notes for Claude Code

- All CLAUDE.md hard rules apply unchanged. Three bite here: authorization only through `permissions.ts` (a new resource, a new action, a new rule, and no ad-hoc checks anywhere in the transfer), process notes author-only at every layer (the departure touches them and must never read one), and state transitions only through the state machine module.
- Adding `'depart'` to `Action` and `'departure'` to `Resource` will fail `permissions.test.ts`'s matrix coverage until every role × action cell is asserted, including the denials. That is the test doing its job — fill the cells, do not narrow the test.
- `notes/service.test.ts`'s grep guard will fire on any new `processNote` query that does not name `authorId` inside the call. The departure's process-note write is a bulk `updateMany` keyed on `authorId` and nothing else, which satisfies the guard honestly rather than by shape — it never selects `content`, and it must not.
- The trigger goes in the migration, not in Prisma. Name it in the register the codebase already uses: `process_note_delete_only_after_departure`, with the trigger `process_note_no_delete_unless_unreachable`.
- The all-or-nothing assertion is the one worth writing first and worth writing badly at first: snapshot every one of the five tables before a conflicting execution and compare wholesale after. A test that checks three client rows will pass a partial rollback.
- Write WRITEUP §29 as this lands, not after. The entry is the pair: what transfers and what does not, and why the reason is the same sentence in both directions.
