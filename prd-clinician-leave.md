# PRD: Clinician Leave — the caseload that is covered, not moved

**Sample business:** "Stillwater Counseling" (as in the parent PRD) — 6 clinicians, 4 rooms, ~70 standing weekly clients
**Builder:** Solo, in Claude Code
**Status:** v0.2 — **reviewed 2026-09-10** (D-14 to D-17 added); Phases 1–4 built, capstone seeded (D-19 added); P1-1 and P1-5 built (D-20 added); P1-3 reviewed and built (D-21 to D-24 added); P1-4 built (D-25 added); a departure while the supervisor is away routed (D-26 added). Decided 2026-09-10: PRD first, then build in phases. Feature PRD, child of `prd-clearpath-counseling-ops.md`; the P2 that `prd-clinician-departure.md` deferred by name
**Learning objectives:** a clinical read grant that is *derived* from a dated row and the injected clock rather than written on the first day and revoked on the last; what hard rule 9's "exactly one reader" means when that one person is away; and the pair with departure — everything that PRD made terminal, made to end on a date without anybody having to end it

---

## ⚠️ Scope Honesty (read first)

This is a **learning project with synthetic data only**. It applies HIPAA-*inspired* design principles — least privilege, honest audit trails, no PHI in messages, URLs or logs. It is **not** HIPAA-compliant software and must never hold real client data.

Two honesty notes specific to this feature:

**Who may cover for whom, and what a covering clinician may do, is a licensure and practice-policy question, not an engineering one.** Some practices cover crisis contact only; some hand a colleague the full weekly session for eight weeks; some require the client to agree first. This PRD designs a mechanism with a named coverer and a dated window. It does not claim its cell choices are the right scope anywhere.

**Telling a client their therapist is away is clinical work.** Nothing here sends that message. The portal already shows who each session is with, and what a client is told about an absence — and whether they are told why — is a conversation.

## Problem Statement

Nour, a therapist, is away for eight weeks from Monday 5 October to Friday 27 November. Fourteen standing weekly clients stay on the books. Dev, a colleague, has agreed to cover.

**What Clearpath can do about this today, accurately: an `AvailabilityOverride` of kind `unavailable`.** The seed already has one — a week of annual leave. It does three things. The calendar shows Nour away, booking refuses Nour's hours, and `vacationImpact` puts every displaced session on `/worklists`. Everything else still points at a clinician who is at work:

- **Dev can read none of it.** Fourteen `Client` rows hold `treatingClinicianId = nour`, and `treatingOrSupervising` decides `client`, `form_submission` and `attendance_history`. When a client rings the practice in distress in week three, the only door is admin break-glass. The seed contains exactly that row: `clinician on leave, client called the practice in distress`. Break-glass is meant to be rare and flagged. Eight weeks makes it routine, and it opens the record to the practice manager, not to a clinician.
- **The screener behind a critical alert is reachable by nobody at work.** Admin has no `form_submission` cell at all, break-glass included. The answers that raised the flag can only be read by the person who is away.
- **Alerts go to the person who is away.** `forms/service.ts` and `messaging/inbound.ts` both address the alert to `client.treatingClinicianId`, per hard rule 9. A `screener_critical_item` raised on 14 October waits unread until 30 November.
- **The books stay open.** `capacity.update` is `self`. Intake's D-09 wrote the cost down in advance: *"a clinician on leave with their books left open is a wrong signal nobody else can correct."*
- **Departure is the wrong tool, on every line.** It repoints the treating clinician, abandons drafts, starts the process-note window and deactivates the account. For somebody coming back, each of those is wrong. The departure PRD said so and deferred this document by name.

None of this is a bug. Every rule above is right for a clinician who is at work. Leave is the first event where the rules have to hold for a named window and then stop, without anybody pressing a button on the last day.

## Goals

1. A leave is **one dated row**, recorded ahead. The practice sees who is away and who is covering from the afternoon it is recorded.
2. **Every active client on the caseload has a named covering clinician from the first moment the leave exists.** No default and no silent remainder, and no list of undecided clients racing the start date.
3. The coverer can **read what they need to act on a client in crisis, or hold that client's session**, for exactly the window. The grant **ends by itself**: no write has to happen for access to stop.
4. An alert raised during the window reaches **exactly one person who can act on it**, and that person is the coverer. Hard rule 9 is unchanged.
5. **Nothing about Nour's relationship to their clients changes.** Treating clinician, authorship, drafts, series and process notes all stay where they are.
6. **Process notes never widen.** The coverer is refused Nour's, no window starts, and the notes Dev writes privately while covering are Dev's alone afterwards.
7. The audit log shows every read that coverage decided, which leave it rested on, and that the reads stopped.

## Non-Goals

- **The treating clinician never changes during a leave.** Coverage is a second relationship with an end date, not a transfer that gets reversed. This is the non-goal the rest of the PRD is shaped around (D-01).
- **No automatic rescheduling.** WRITEUP §2 stands: moving somebody's standing hour is a conversation, not a write. The displaced-session work-list is already the answer, and it keeps working unchanged (D-11).
- **No on-call rota and no shared inbox.** A practice with a rota still names one person per leave. Rule 9 says one reader, and a rota is an HR artefact.
- **No leave requests, approvals, accrual or reasons.** The row records *that* Nour is away, never why: parental, medical and bereavement leave are private facts about an employee, and the calendar is read by front desk (D-12).
- **No client messaging and no client consent capture.** See the honesty note above.
- **No `update` for the coverer** on the client, fee, attendance or portal link. The grant is sized to acting on a crisis or holding a session, not to running the caseload (D-04).
- **No coverage for a bare `AvailabilityOverride`.** A sick afternoon stays "away, uncovered", exactly as today. Coverage exists only where somebody recorded a leave (D-11). P1-1 makes the gap countable.

## Personas

- **Ray, practice manager (admin).** Records the leave and names the coverer. Cannot read a clinical record to do so, and must not need to.
- **Nour, therapist (away).** Wants the caseload safe while they are gone and to come back to an accurate record. May sign a draft from home; must not be the only reader of a critical alert for eight weeks.
- **Dev, therapist (covering).** Picks up the call in week three and needs that client's record and screener answers that afternoon. Must lose that access on 28 November without anybody remembering to remove it.
- **Sam, supervisor.** Decides which colleague covers which client when a long leave splits. For an active leave the decision is the grant (D-15).
- **Dana, front desk.** Must stop offering Nour to new callers, and must tell a distressed caller who is covering. Never sees why Nour is away.
- **Jo, auditor.** Must see that Dev read a client of Nour's, on which leave, and that the reads stopped on the 28th, without learning anything clinical.

## User Stories (priority order)

1. As **Ray**, I record that Nour is away from 5 October to 27 November with Dev covering. That afternoon, front desk sees both facts and Nour stops appearing as open to new callers.
2. As **Sam**, I move two of Nour's clients to Kai, who has the Thursday hours. Every other client stays with Dev, and each change records who decided it.
3. As **Dev**, on 14 October, I open a covered client's record and the screener that raised the alert I was sent, with no break-glass and no ticket.
4. As **Dev**, on 30 November, I am refused the same record. Nothing had to run for that to be true.
5. As **Nour**, on 30 November, the alert Dev never acknowledged is back with me. The one Dev acknowledged still says Dev acknowledged it.
6. As **Jo**, I see every read that coverage decided, each naming its leave, and none after the 27th. None of it tells me what the client came in for.

## Requirements

### Must-Have (P0)

**P0-1: `Leave` is a dated row with a required coverer, and coverage can split by client**

- `Leave`: `userId`, `fromDate` and `toDate` (`@db.Date`, inclusive, in the idiom of `AvailabilityOverride`), `coveringClinicianId` (required), `plannedById`, `cancelledAt?`, `overrideId` (the calendar row, P0-7).
- `LeaveCoverage`: `leaveId`, `clientId`, `coveringClinicianId`, `decidedById`, `decidedAt`, unique on `(leaveId, clientId)`. An override for one client. **There is no row for "same as the leave".**
- Constraints, not validators:
  - `leave_no_overlap`: a `gist` exclusion on `(userId, daterange(fromDate, toDate, '[]'))` where not cancelled. A person may book summer and winter leave ahead, but not two leaves over the same days.
  - CHECKs: `toDate >= fromDate`, and neither coverer is the person away.
- Rejected: the departure shape, one assignment row per client with no leave-level coverer. D-13 of the departure PRD refused a default for who *treats* somebody. Covering is a different question (D-03).

**P0-2: A leave's phase is derived, and the one transition goes through a state machine**

- `leavePhase(leave, today)` is a pure function: `upcoming | active | ended | cancelled`, from `fromDate`, `toDate`, `cancelledAt` and the practice-local date of the injected clock.
- The one stored transition is `upcoming → cancelled`. It lives in a `TRANSITIONS` table in `src/staff/leave.ts`, shaped like `scheduling/lifecycle.ts`, per hard rule 8.
- **Early return is an edit to `toDate`, never a transition.** It may shorten as far as yesterday, which is "back today" (D-18): the leave has ended when the edit commits. It only works while the leave is active, and a leave whose first day is today cannot end before it. **Extending** is also an edit, and `leave_no_overlap` decides it.
- **An ended leave is frozen.** No date edit, no coverage edit. It is the record of who could read what, and on which days.
- Rejected: a stored `active` status set by a runner on the first day. A grant that starts or ends by a write is a grant that is wrong on any day the runner did not run (D-02).

**P0-3: `leave` is a resource, and coverage is two named rules** *(core learning artifact)*

- `Resource` gains `'leave'`. **No new action:** nothing here deactivates an account, destroys a row or moves a caseload (D-08).

  | role | leave |
  |---|---|
  | admin | `read: always`, `create: always`, `update: always` |
  | supervisor | `read: always`, `update: always` |
  | front_desk | `read: always` |
  | therapist / associate | `read: self` |
  | auditor | — (`audit_log` only, as today) |
  | client / public | — |

  Front desk reads because they answer the phone to "who do I talk to while Nour is away?". A supervisor decides who covers which client. Unlike a departure, where admin's `depart` turns a proposal into access, a supervisor's `update` on an active leave *is* the grant (D-15). Only admin creates, because creating is what closes the books (P0-6). **Break-glass appears nowhere in this row.**

- `Target` gains `coverage` (`leaveId`, `coveringClinicianId`, `fromDate`, `toDate`, `cancelledAt`) and `today`. The caller resolves *which* leave (the treating clinician's open one) and *which* coverer (the client's `LeaveCoverage` row, else the leave's), the way it resolves a supervisor. **It does not decide whether the leave is on today.** The rule calls `leavePhase` on the dates it was handed, so the one date-shaped grant is decided in `permissions.ts` (D-14).
- Three new rules, enumerated in the departure PRD's D-15 register. None widens an existing rule in place:
  - `treatingCoveringOrSupervising` = `treatingOrSupervising` ∪ the coverer.
  - `authorSupervisorTreatingOrCovering` = `authorSupervisorOrTreating` ∪ the coverer.
  - `treatingOrCovering` = `treating` ∪ the coverer.
- The coverer is `covers`: named on the target, not an associate (D-13, held again at read time), and `leavePhase(coverage, today) === 'active'`.
- `Decision` gains `coveringLeaveId`, set only when the same request without `coverage` would be denied. P0-9's audit reason reads it, so a treating clinician's or supervisor's read is never attributed to a leave.
- The cells that move for clinicians (D-04):

  | resource.action | today | with this PRD |
  |---|---|---|
  | `client.read` | `treatingOrSupervising` | `treatingCoveringOrSupervising` |
  | `form_submission.read` | `treatingOrSupervising` | `treatingCoveringOrSupervising` |
  | `progress_note.read` | `authorSupervisorOrTreating` | `authorSupervisorTreatingOrCovering` |
  | `progress_note.create` | `treating` | `treatingOrCovering` |
  | `process_note.create` | `treating` | `treatingOrCovering` — the note is the coverer's own, and read stays `author` |

- **Unmoved, and asserted as denials to the coverer:** `client.update`, `fee.read`, `attendance_history.read`, `portal_link.*` and `alert.*`, which stays `recipient`.
- **Only the coverer gains access.** The coverer's supervisor does not, and neither does anyone else. A coverer must be a `therapist` or `supervisor` (D-13).
- **It fails closed.** A call site that forgets to resolve `coverage` or `today` denies Dev; it never over-grants. That is the property that makes a derived grant safe to spread across call sites, and a test pins it.

**P0-4: Process notes do not move, in any way, at any priority**

- `process_note.read` stays `author`. Dev is refused Nour's process notes on every day of the leave, and so are the supervisor, admin and admin with break-glass.
- **No window starts.** `unreachableSince` is a departure's column and a leave never sets it. Nour reads their own notes from home if they choose.
- Dev's own process notes, written while covering, stay `author`. After the leave they are still Dev's, readable by Dev and nobody else, and they never reach Nour. That is the psychotherapy-notes distinction applied in the coverage direction, and it gets its own denial test.

**P0-5: One reader per alert, and the reader is someone at work** *(small, and it shows rule 9 holding)*

- The two alert-creation sites stop reading `client.treatingClinicianId` directly. They call one `alertRecipient(tx, clientId, today)`, which returns the coverer when the treating clinician's leave is active and the treating clinician otherwise. A third site cannot forget coverage, because there is only one function to call.
- `Alert` gains `coveringLeaveId?`, which records that coverage chose the recipient.
- Boundary moves, in the departure PRD's D-14 register:
  - **When a leave becomes active:** unacknowledged alerts addressed to the person away move to that client's coverer, stamped with the leave.
  - **When it ends:** unacknowledged alerts stamped with the leave move back to the treating clinician.
  - **Acknowledged alerts never move.** "Dev saw this on 14 October" is a fact about 14 October.
- Boundary moves are a clock-driven sweep on the existing shared runner (departure D-16), and they are idempotent. The early-return edit performs the "ends" move in its own transaction. **Access does not depend on the sweep. Only moving alerts that already existed does**, and every alert raised during the window was addressed correctly when it was raised.

**P0-6: The books close for the window, derived rather than written**

- Front desk's capacity reading becomes `acceptingNewClients && !onLeave(today)`. Nothing is written, so nothing has to be restored. The departure PRD stored `acceptingNewClientsAtNotice` so a write could be undone; with no write there is nothing to store (D-07).
- **Admin still does not hold `capacity.update`**, and intake's D-09 stays unweakened. Nour's own declared value is untouched, and it reads correctly again on 30 November.

**P0-7: The leave owns its calendar row**

- `leave.create` writes the `AvailabilityOverride` in the same transaction, with the generic reason `Leave`. Date edits move both rows, and cancellation removes the override. Booking, the calendar and `vacationImpact` keep reading overrides and do not learn that leaves exist.
- The override is the calendar's source. **It is never coverage's source**, and a bare override grants nobody anything (D-11).

**P0-8: A departure cannot execute over an open leave**

- `departureBlockers` gains `leave_open`: an upcoming or active leave for the departing clinician. End it or cancel it first. This follows D-30's reasoning: two plans moving the same caseload on overlapping days is a half-moved state waiting to happen.
- A coverer who is departing before the leave ends, is inactive, or has their own leave overlapping the window is a blocker on the leave's plan screen. It is refused at the door when a coverer is named (departure D-26), and scanned continuously afterwards, because Dev booking their own week off in November is Dev's fact to record, not Nour's leave's to refuse.

**P0-9: What the audit log gains**

- Every write above is audit-logged in the same transaction as the action (hard rule 4). That covers create, each coverage decision, each date edit, cancellation, and each alert moved.
- A read decided by a coverage rule already records the rule's name. It also carries `reason: 'leave:<leaveId>'`, an id and never free text, so Jo can list every read a leave made possible without joining dates by hand.
- The sweep's actor is `SYSTEM_ACTOR` through `auditEvent`, following departure D-19.

### Nice-to-Have (P1)

- **P1-1: The uncovered-absence count.** An alert raised for a clinician whose active `unavailable` override has no leave behind it is counted on `/worklists` for admin. It is a count and never a client, per departure D-25. The seed's week of annual leave is precisely this case today.
- **P1-2: Coverage markers.** Covered clients appear in Dev's caseload list as "covering for Nour until 27 Nov". The client record, at the demographic tier, tells front desk "Nour away until 27 Nov · covering: Dev". Names and dates only, never a reason.
- **P1-3: Supervisor coverage.** `Leave.coveringSupervisorId` for a supervisor who is away: the co-sign queue and supervisee caseload reads, same derived shape. It is P1 because `supervises()` also decides `progress_note.read` for every supervisee note, so the widening is larger than the clinician case and deserves its own review. See Open Questions. **Reviewed and built 2026-09-11 (D-21 to D-24):** co-sign plus the four reads a co-signature needs, for the window, from the supervisor role only; required at the door for somebody who supervises anyone.
- **P1-4: "While you were away."** Nour's first screen back lists flagged submissions, sessions Dev held and notes Dev wrote during the window. All of it comes through reads Nour already holds as treating clinician. No new cell. **Built 2026-09-11 (D-25):** a "While you were away" section at the top of `/worklists`, where Home sends the person back for a fortnight after the last day; three treating reads in one transaction, and never a process note.
- **P1-5: Leave section on `/worklists`.** Upcoming and active leaves, the coverer blockers, and the count of unread alerts that will move when a leave starts. Counts only. **2026-09-14:** a blocked supervision cover joins them, as the plan screen's own `supervisionBlocked` (P1-3) rather than a second scan — the one item there that is not a number, because a supervision gap has no size.

### Future Considerations (P2)

- **An on-call rota** that names one coverer per day across several leaves. The model already names one coverer per client per leave; a rota would name it per day.
- **Clinician-recorded leave**, with admin confirming coverage.
- **Partial-day coverage** for a sick afternoon.

## Success Metrics (evaluated against synthetic seeded data)

**Leading**
- Permission matrix: every `leave` cell asserted, including every denial.
- Each widened cell is asserted on the clock's boundaries. The coverer is allowed on `fromDate` and `toDate`, and denied the day before, the day after, after cancellation and after an early return. A client with a `LeaveCoverage` override admits that coverer and denies the leave-level coverer.
- The coverer is denied `client.update`, `fee.read`, `attendance_history.read` and `portal_link.create`. The coverer's supervisor is denied everything the coverer gained.
- `process_note.read` on the absent clinician's notes is denied during an active leave to the coverer, the supervisor, admin and admin with break-glass. The absent clinician still reads them. The coverer's own process note is denied to the absent clinician after return.
- Fail-closed: a target built without `coveringClinicianId` denies the coverer.
- Alert routing: a critical screener on day two produces exactly one alert, to the coverer. The same submission the day after `toDate` produces one alert to the treating clinician. At the boundaries, unread alerts move and acknowledged ones stay.
- `leave_no_overlap` and both CHECKs refuse bad rows against a real connection, not a mock.
- A departure with an open leave raises `Conflict('leave_open')`.

**Lagging (simulated)**
- The seeded annual leave becomes a `Leave` covered by Dev, with one client split to Kai. A screener crosses threshold on day two and an unparsed text arrives on day three. Dev reads both clients' records and **no break-glass row is written**. On the day after return:
  - Dev is refused the record.
  - The alert Dev did not acknowledge is back with Nour, and the one Dev did still names Dev.
  - Jo's filter on `leave:<id>` lists exactly Dev's reads.
  - No actor has read a line of Nour's process notes at any point.

## Decisions

| # | Decision | Why |
|---|---|---|
| D-01 | The treating clinician never changes during a leave; coverage is a second, dated relationship | A departure repoints because the relationship ended. For a leave, repoint-then-restore is a write that has to be undone correctly, and the restore is a guess about what happened in between. A client moved to a colleague for fit during week five would be taken back on return, which is departure D-26's bug met from the other side. With no repoint there is nothing to undo |
| D-02 | Coverage access is derived at read time from the leave's dates and the injected clock, never granted and revoked | A grant that ends by a write outlives any day the write did not happen, and here that means clinical access that should have stopped. Derived from the row, the last day is the last day whether or not anything ran. It fails closed at every call site that forgets coverage, and the clock makes both boundaries testable |
| D-03 | Every leave names one required coverer at creation, and per-client coverage is an optional override | Departure D-13 refused a default for who *treats* somebody, because clinical fit has no correct default. Who picks up a crisis for eight weeks is on-call, and a named person chooses it. Making it required means "every client is covered" holds from the first row, rather than a blocker list that cannot stop the start date arriving |
| D-04 | The coverer gains read on `client`, `form_submission` and `progress_note`, and create on `progress_note` and their own `process_note`, and nothing else | Sized to two jobs: acting on a crisis (the record and the screener behind the alert) and holding a displaced session (writing it down). Fee, attendance history, portal links and client updates run a caseload, and Nour still does that on return. Every cell left out is asserted as a denial |
| D-05 | `process_note` is untouched, and no window starts | A leave is not an ending. The notes are Nour's work product, and Nour is coming back to them. The coverer's own private notes are theirs in the same way, so the rule is the same sentence in both directions |
| D-06 | Alerts route through one `alertRecipient` at creation, and only existing unread alerts move at the boundaries | Routing at creation makes every alert raised in the window correct without depending on a runner. The sweep handles only what was already unread, so a missed run delays those alerts and never misroutes a new one. Acknowledged alerts never move (departure D-14) |
| D-07 | The books close by derivation, not by writing `acceptingNewClients` | The departure PRD stored the value at notice so cancellation could restore it. Here there is no write, so there is no restore, no stored copy and nothing for admin to set. Intake's D-09 cost is answered without anybody gaining `capacity.update` |
| D-08 | `leave` is a resource with no new action | `depart` earned its own action by deactivating an account and moving a caseload. A leave does neither. The widening is decided in `update` on a dated plan, the cell supervisors already hold for departures, and it is reviewable in the matrix as two named rules |
| D-09 | A departure cannot execute over an open leave | Two plans moving one caseload on overlapping days is a half-moved state with no clash to catch it. Ending the leave first is one edit |
| D-10 | Early return shortens `toDate`; nothing else about the leave is a transition | The phase is a function of dates. A stored `ended` beside a `toDate` that says otherwise is two facts that can disagree. The one stored transition, cancellation, is the one that is not a date |
| D-11 | A leave writes its own `AvailabilityOverride`, and a bare override grants nothing | Four consumers already read overrides correctly, so the leave keeps them fed rather than teaching them a second source. Coverage rests only on a leave, because a grant of clinical access must be a recorded decision naming a person, never a side effect of blocking out a calendar |
| D-12 | A leave stores no reason | Why an employee is away is private to them, and the calendar is read by front desk. The override carries the generic `Leave` |
| D-13 | A coverer must be a `therapist` or `supervisor` | An associate's covering notes need a co-signature from their own supervisor, who has no read on the client, so they would countersign blind. That is exactly what `treatingOrSupervising`'s comment exists to prevent. Refusing associate coverers in V1 avoids it; P1-3 is where it would be solved, and D-24 declined to |
| D-14 | Whether a leave is on today is decided inside `permissions.ts`, from dates on the `Target` | Settled in review, 2026-09-10. As v0.1 read, the resolver set `coveringClinicianId` only on an active day, which put a date-based access decision outside the one file hard rule 1 allows, and left the Phase 1 boundary tests nothing to test. The caller still resolves which leave and which coverer, as it resolves a supervisor. It passes dates and `today`, and `covers` decides. It also lets `can()` report the leave that made the difference, which P0-9's audit reason needs |
| D-15 | A supervisor keeps `leave.update: always`, and their write is a grant | Settled in review. Story 2 is a clinical-fit judgement, which is supervision's work. The departure shape does not carry over: there, admin's `depart` turns a supervisor's proposal into access; here, a `LeaveCoverage` row or a `toDate` extension on an active leave widens read access when it is written. Admin-only was narrower and put fit with the practice manager. A split `leave_coverage` resource was more precise, at the cost of a matrix row D-08 argued against. Accepted with the audit row as the control |
| D-16 | The coverer holds routine sessions as well as crisis contact: all five D-04 cells | Settled in review; closes the first Open Question. An eight-week leave means displaced sessions, and a session held with nothing written down is a worse record. A crisis-only practice drops `progress_note.create` and `process_note.create` |
| D-17 | Supervisor coverage stays P1 | Settled in review; closes the third Open Question. `supervises()` decides every supervisee note and co-signature, so the widening is larger than the clinician case and gets its own review before it is built |
| D-18 | Early return may set `toDate` to yesterday, and that edit returns the leave's unread alerts | Settled 2026-09-11 in Phase 3. Shortening only to today left the leave on until midnight. The "ends" move P0-5 put in the edit then had nothing to move, and a clinician back at their desk had their alerts going to a colleague all day. Ending the leave at the edit stops access and alerts together, at the moment a person says so. A leave whose first day is today still runs to midnight, because `leave_ends_after_it_starts` refuses anything else |
| D-19 | A leave write that changes who reads an alert today moves that leave's unread alerts in its own transaction | Settled 2026-09-11 in Phase 4. Phase 3 moved them only on the hourly sweep, apart from an early return. After a supervisor split a client to Kai mid-leave, the matrix refused Dev the record at once, while the alert behind it stayed with Dev until the next run. Recording a leave that starts today, naming a coverer, deciding a client and moving dates all now call the same `rerouteAlerts` the sweep uses. The sweep is still what moves alerts at the date boundaries, when nobody writes anything |
| D-20 | The uncovered-absence count reads on `leave.read`, and the screen shows it to `leave.create` | Settled 2026-09-11 with P1-1. Guarding the read as `create` would write an audit row saying the practice manager created a leave. The count holds no client (departure D-25), the same kind of number front desk already sees about a departure. The screen asks `may` for `leave.create` because recording a leave is the fix. It counts unread alerts to a recipient with an `unavailable` override active today and no leave behind it |
| D-21 | A supervision cover gains `progress_note.cosign` and read on `progress_note`, `client` and `form_submission`, for the window, and nothing else | Settled in the P1-3 review, 2026-09-11. The need is the co-signature clock, and a countersignature given without the note, the record and the screener behind it is signed blind, which `treatingOrSupervising`'s comment exists to prevent. Those are the reads a clinician coverer holds, so a cover reads the same on either kind of leave. Fee, attendance history, portal links and client updates run a caseload and stay denied; `process_note` is untouched. The note read reaches everything the away supervisor's supervisees wrote, not only what awaits co-signature: that is `supervises`'s own reach, accepted for the window. Rejected: the full mirror (simplest, and wider than a clinician coverer), a co-sign-queue-only cut (a note status on the `Target`, a status-shaped rule nothing else in the matrix has), and reads without co-signing (safe on licensure, and leaves the clock the item exists for) |
| D-22 | `Leave.coveringSupervisorId` is optional, required at the door for somebody who supervises anyone, and scanned on the plan screen | Most people away supervise nobody, so a required column would name a meaningless cover on most leaves. Supervision is data that changes after a leave is recorded, so no CHECK can hold "required while supervising": the door refuses `supervision_uncovered`, and the plan screen flags a missing or unavailable cover on every read (P0-8). The cover passes `maySupervise`, asked of the matrix, and `coversAuthorSupervisor` refuses any role but supervisor again at read time, as D-13 does for coverers |
| D-23 | Supervision coverage is two `Target` facts; the two covering read rules widen in place, and co-signing gets a new rule, `supervisorOfAuthorOrCovering` | `supervises` reads the note author's supervisor and `supervisesTreating` the treating clinician's. For an older note those can be different people, so `authorSupervisorCoverage` and `treatingSupervisorCoverage` travel beside the ids they cover. The read rules already end in "covering", and a supervision cover is a cover on the same dated window, so their names still say who — departure D-15's test. `supervisorOfAuthor` did not say it, so it was renamed rather than widened under an old name. `can()` names a leave when any of the three coverages made the difference |
| D-24 | D-13 stands: associates still do not cover | Settled in the P1-3 review. An associate coverer needs their own supervisor to gain read on the covered clients: a third widening, reversing the pinned "the coverer's own supervisor gains nothing" test. It deserves its own review, not a ride on this one |
| D-25 | "While you were away" shows for 14 days after a leave's last day, on `/worklists`, where Home lands the person back; nothing is written on return | Settled 2026-09-11 with P1-4. A dismissal is a write and a stored state for a list that goes stale by itself, and a fortnight covers a first week back and a part-time second. Home's redirect makes it the first screen without a second list on `/calendar`. Sessions and notes are anybody's but the clinician's own, not only the named coverers', because a split undone mid-leave still held its sessions. Submissions filter on the request's `submittedAt`, which is the injected clock's, not the row's `createdAt` |
| D-26 | An alert belongs to its treating clinician, or to a departed clinician's supervisor, and a leave covers whoever it belongs to | Settled 2026-09-11. Departure P0-7 passes a discharged client's unread alert to the leaver's supervisor, but the sweep routed by treating clinician: a supervisor's cover never received it, and the leave's end would have returned it to the closed account. One `ownerOf` inside `routesOf` makes alert creation, execution, the sweep and every settling write agree in either order, and a new alert about that client stops reaching the closed account. The cover receives it on the days `coversTreatingSupervisor` lets them open the record, because both read `supervisionCoverageOf`. Rejected: routing only at execution (a leave starting afterwards still missed it), and a blocker while the supervisor is away (the departure waits weeks while the alert sits with somebody who has gone) |

## Risks and objections

- **"You gave clinical access to somebody who is not treating the client."** Yes: to one named person, on dated days, over five cells. Each cell is asserted on both boundary days and against the neighbouring roles. The alternative in production today is break-glass, which gives the practice manager wider access than this and records it as an emergency every time.
- **"A derived grant is invisible in the data."** There is no grant row to inspect, so "who could read this client on 14 October" is answered by joining leaves, not by reading a table. P0-9's `leave:<id>` reason is the mitigation: the auditor sees the grant used, and a report can list the grant as it stood.
- **Midnight is the boundary, in the practice's zone.** A crisis at 23:40 on the 27th is covered and one at 00:10 on the 28th is not, because Nour is back. That is correct, and it will occasionally be inconvenient.
- **The coverer can be overloaded.** Fourteen clients on top of their own caseload is a capacity problem this PRD does not measure. P1-5 counts it; a practice decides it.
- **The seeded supervision cover is a leave, not a departure.** Rosa away with Tom on her clients and Dev on her supervision is P1-3 end to end. D-26's routing — a departed clinician's alert reaching their supervisor's cover — still has no seeded picture, because the seed's one departure is planned rather than executed, and executing it would spend the departure demo.
- **Whether a covering supervisor may countersign for somebody else's associate is a licensure question** (P1-3). Some boards require the supervisor of record. The mechanism names one person for dated days and records every co-signature against the leave; it does not claim the practice may use it.
- **A departure executed while the leaver's supervisor is away** passes unassigned alerts to the supervision cover for the window and back to the supervisor after it (D-26). A supervisor away with no cover still holds them; the door and the plan screen are the control (D-22).
- **The migration touches `Alert` and `permissions.ts` cells every clinician holds.** New columns are nullable. The matrix change is five cells, and `permissions.test.ts` refuses to pass until each is asserted.

## Open Questions

- ~~**(Product)** Does the coverer hold routine sessions, or only crisis contact?~~ **Settled: both (D-16).** V1: both. `progress_note.create` is in D-04 because an eight-week leave means displaced sessions, and a session held with nothing written down is a worse record. A practice that covers crisis only would drop two cells.
- **(Product)** Should Nour keep read access while away? V1: yes. They remain the treating clinician and may sign a draft. Revoking access during leave is a disciplinary act with a different name, not a leave.
- ~~**(Product)** Is supervisor coverage (P1-3) actually P0?~~ **Settled: stays P1 (D-17).** A supervisor away for eight weeks leaves associates' notes unsigned against a compliance clock. It is P1 only because its widening is larger and should be reviewed on its own.
- ~~**(Builder)** Which runner hosts the boundary sweep: `purge:run`, whose D-16 argued for one schedule, or `reminders:run`?~~ **Settled in Phase 3: `reminders:run`.** The sweep is idempotent and late rather than wrong when missed, which is that runner's contract. Its only cost is lateness, and a nightly purge would leave an unread critical alert with somebody away for most of a day. `purge:run` shares a schedule because its sweeps destroy data, and this one destroys nothing.

## Timeline / Phasing

- **Phase 1:** `leavePhase` and its boundaries; the `leave` matrix row and every denial; the three new rules with boundary-day tests; the `process_note` denials. Pure logic, TDD, per CLAUDE.md's ordering. The fail-closed test belongs here.
- **Phase 2:** schema. `Leave`, `LeaveCoverage`, `leave_no_overlap`, the CHECKs, `Alert.coveringLeaveId`, and the override coupling, all audit-logged. Constraints asserted against a real database.
- **Phase 3:** wiring. Coverage resolution in `clientTarget` and `caseloadWhere`, `alertRecipient` at both creation sites, the boundary sweep, derived capacity, and the `leave_open` departure blocker.
- **Phase 4:** the leave plan screen (record, name the coverer, split clients, early return), front desk's view, and P1-2 markers.
- **P1-3:** landed 2026-09-11 after its own review (D-21 to D-24). `coveringSupervisorId`, two `Target` facts, the co-sign queue, caseload and note list through `supervisionCoveredBy`, and a Supervision card on the plan screen.
- **P1-4:** landed 2026-09-11. `whileYouWereAway` on `/worklists`, and Home lands a returning clinician there for 14 days (D-25).
- **P1-1, P1-5:** landed 2026-09-11. `leaveWorklist` and `uncoveredAbsenceAlerts` give `/worklists` a "Somebody is away" section, counts only (D-20).
- **Capstone demo:** the Lagging scenario as a seeded leave and a spec, on an advanced clock.

## Build Notes for Claude Code

- All CLAUDE.md hard rules apply. Four bite: authorization only through `permissions.ts` (coverage is a `Target` fact, never a check at a call site), process notes author-only at every layer, alerts to exactly one person, and no bare `new Date()` — every phase decision takes the injected clock.
- Adding `'leave'` to `Resource` fails `permissions.test.ts` until every cell is asserted. Fill the cells; do not narrow the test.
- **Phase 1 landed the rules; Phase 3 owns resolution.** A resolver test must show a `LeaveCoverage` override naming Kai beating the leave-level coverer, because in pure logic that is only "the id on the target".
- `clientTarget` is not the only resolver. `app/(staff)/clients/[id]/page.tsx` and `scheduling/worklists.ts` build targets by hand. Route every one through a single coverage lookup, and grep for `treatingSupervisorId:` to find them. The fail-closed property means a missed site is a denial in a test, not a leak, but find them anyway.
- The mutation check from WRITEUP §35 applies: after the boundary tests pass, shift the practice zone or remove the `toDate` comparison and confirm a test goes red.
- Write the WRITEUP entry as Phase 1 lands. The entry is the pair with §29: the same caseload, and a grant that ends by itself instead of a transfer that cannot be undone.
