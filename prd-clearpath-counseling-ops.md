# PRD: Clearpath — Clinic Operations for a Counseling Practice

**Sample business:** "Stillwater Counseling," a group practice with 6 clinicians (2 licensed supervisors, 3 licensed therapists, 1 pre-licensed associate) sharing 4 therapy rooms (works for therapy, psychiatry, coaching practices)
**Builder:** Solo, in Claude Code
**Status:** Draft v1.0 — counseling-domain revision of the Chairside clinic-ops PRD; PM + practice-operator review baked in (review notes tagged inline)
**Learning objectives:** role-based access control with tiered record sensitivity, immutable audit logging, dynamic forms with scoring, dual-resource scheduling with conditional resources, recurring appointments, supervisory co-sign workflows

---

## ⚠️ Scope Honesty (read first)

This is a **learning project with synthetic data only**. It applies HIPAA-*inspired* design principles — least-privilege access, audit trails, no PHI in logs/URLs, and the psychotherapy-notes distinction — because they're excellent engineering discipline. It is **not** HIPAA-compliant software and must never hold real client data. State this in the repo README verbatim. Mental-health data is among the most sensitive that exists; modeling the protections is the lesson, claiming them would be the credibility-killer.

## Problem Statement

A counseling practice runs on trust and rhythm: the same client, the same clinician, the same hour every week. Operationally that means recurring appointments, shared therapy rooms, late-cancellation policies, and — above everything — layered confidentiality. The front desk must run the calendar without seeing why anyone is there. A supervisor must co-sign an associate's progress notes but must *never* see any therapist's private process notes. Even appointment reminders must be discreet. Generic scheduling tools fail this domain because confidentiality tiers and supervision workflows are bolted on, not built in.

Builder-side, this targets the feature families demo apps always skip: **RBAC with tiered record sensitivity** (harder than dental's — two classes of clinical note with different rules), **append-only audit logging**, **scored dynamic forms**, and **dual-resource scheduling where one resource is conditional** (telehealth needs no room).

## Goals

1. Every user sees exactly what their role permits — enforced server-side in one module — including the psychotherapy-notes rule: private process notes are visible to their author only, no exceptions, not even supervisors or break-glass.
2. Every read and write of a client record is captured in an immutable audit log queryable by an auditor role.
3. Clients complete intake, consent, and scored screeners via tokenized link; submissions bind to the form version they completed.
4. Recurring weekly sessions book provider + room together with zero double-bookings of either — and telehealth sessions correctly skip the room requirement.
5. Associates' progress notes route to their supervisor for co-signature before the record is complete.
6. **(Builder goal)** Exercise RBAC with sensitivity tiers, audit trails, scored forms, conditional multi-resource scheduling, and recurrence.

## Non-Goals

- **Insurance billing / claims (CPT coding, superbills)** — an industry unto itself; a session's "completed + fee" record is the designed hook (P2). Sliding-scale fee per client IS in scope — it's one field and a real practice norm.
- **Telehealth video itself** — video infra is config/integration, not logic. The appointment carries a modality flag and a join-link text field; the scheduling consequences of modality are the lesson.
- **Real HIPAA compliance / BAAs / encryption certification** — see Scope Honesty.
- **Client accounts/login** — tokenized links, per house convention.
- **Outcome analytics dashboards on screener scores** — score capture and threshold flags are P0; longitudinal analytics are P2 (and ethically fraught to gamify — note this in the write-up).
- **Group therapy sessions** — one appointment/multiple clients breaks the data model in interesting ways; deliberately deferred to P2 so v1's model stays clean.

## Personas

- **Front desk** — runs the calendar, check-in, sends forms, manages waitlist; sees names, times, clinicians — **no clinical content, no session focus, no diagnoses**.
- **Therapist (licensed)** — full clinical access for *their* clients; writes progress notes and private process notes; signs own notes.
- **Associate (pre-licensed)** — same as therapist for their clients, but progress notes require supervisor co-signature.
- **Supervisor** — everything a therapist has, plus: reads and co-signs their supervisees' *progress* notes. **Cannot** read anyone's process notes, including supervisees'. *(operator review: this asymmetry is the domain's defining access rule — model it exactly)*
- **Practice manager (Admin)** — users/roles, schedules, fees, reports; clinical access only via logged break-glass — which reaches progress notes but **never** process notes.
- **Auditor** — read-only audit log; cannot read client records.
- **Client** — forms and confirmations via tokenized links; never logs in.

## User Stories (priority order)

1. As a practice manager, I want to assign roles and supervision relationships (associate → supervisor) so that access and co-sign routing follow structure, not memory.
2. As front desk, I want to book a recurring weekly session (same client, clinician, hour) that reserves a therapy room each week so that standing appointments — the practice's backbone — manage themselves. *(reuses Groundwork's recurrence-engine pattern against Bookable's atomic-booking pattern — the two hardest prior lessons composed)*
3. As front desk, I want telehealth sessions to skip the room requirement so that a full room map never blocks a video session.
4. As a therapist, I want to write a **progress note** (the official record) and separately a **private process note** per session so that my working notes stay mine. *(the two-tier note model is core learning artifact #1)*
5. As an associate, I want my signed progress notes to route to my supervisor for co-signature so that my records are complete and compliant with supervision requirements.
6. As front desk, I want to send intake + consent + a scored screener before the first session so that the clinician walks in prepared.
7. As a therapist, I want a screener response that crosses a configured risk threshold — including any positive response on a designated critical item — to alert me immediately and privately so that I can follow up with the client directly. *(operator + PM review: alert routes to the treating clinician only; it is a clinical-workflow notification, never an automated intervention)*
8. As front desk, I want late cancellations (inside a configurable window, default 24h) tracked distinctly from advance cancellations so that the practice's late-cancel policy is enforceable. *(operator review: this is a revenue-survival policy in counseling)*
9. As an auditor, I want to query who accessed client X and what they touched so that access is provable.
10. As front desk, I want a "no future appointment" queue (clients whose last session completed with nothing scheduled) so that continuity-of-care lapses surface instead of hiding. *(the counseling analog of dental's recall queue)*
11. As a practice manager, I want to edit form templates without breaking past submissions so that old records render correctly.

## Requirements

### Must-Have (P0)

> **Status.** Every box below is ticked against a named test, not against a
> memory of building it — the permission matrix asserts all 874 cells including
> the denials, and the e2e sweep walks the capstone flow. The P1 items shipped
> in the same phase. `npm test` runs a typecheck first, so the boxes cannot
> quietly stop being true.

**P0-1: RBAC core with sensitivity tiers** *(core learning artifact #1)*
Permission matrix: role × resource × action, where clinical notes are TWO resources with different rules — `progress_note` (author + supervisor-of-author + break-glass) and `process_note` (author only, ever).
- [x] Matrix lives in one declarative file; test suite asserts every cell, allowed and denied, 100% coverage
- [x] A supervisor requesting a supervisee's process note gets a 403; the denial is audit-logged
- [x] Break-glass reaches demographics and progress notes with required reason + flagged audit entry; a break-glass request for a process note is denied and flagged
- [x] No endpoint performs ad-hoc role checks (grep/lint test: authorization only via the module)
- [x] Supervision relationships are data, not code: reassigning an associate's supervisor immediately reroutes both access and co-sign flow

**P0-2: Audit log**
Append-only: actor, role, action, resource type + id, timestamp; written in the same transaction as the action.
- [x] No UPDATE/DELETE path on audit rows, enforced at the DB layer
- [x] Reads of clinical data are logged, not just writes; process-note reads by the author are logged too
- [x] No PHI in the log, in URLs, or in app logs — ids only
- [x] Risk-threshold alerts (P0-6) appear in the audit stream as events without the response content

**P0-3: Client record**
Demographics, emergency contact, consent status, assigned clinician, fee (standard or sliding-scale override, integer cents), session history.
- [x] Front desk sees demographics, schedule, and consent/fee status — never session focus, screener scores, or notes
- [x] A client's record shows "consents outstanding" prominently until intake forms complete *(operator review: seeing a client without signed consent is a liability event)*

**P0-4: Scheduling — recurring + dual-resource with conditional room** *(core learning artifact #2)*
Appointment types: intake (75 min), standard session (50 min), extended (80 min). Modality: in-person (requires a room) or telehealth (no room). Recurring weekly/biweekly series generate instances on a rolling horizon, idempotently, each instance atomically reserving clinician + room (when in-person).
- [x] Given all 4 rooms booked at 3:00 Tuesday, when booking in-person, then 3:00 does not offer — but a telehealth booking at 3:00 succeeds
- [x] Race test: simultaneous bookings of the last room — exactly one succeeds
- [x] Recurring series edits regenerate only future, unstarted instances; a rescheduled instance detaches from its pattern (same regression as Groundwork)
- [x] Clinician working hours reuse the weekly-pattern + override model; a clinician's vacation surfaces every affected recurring client as a reschedule work-list for front desk *(operator review: vacations against standing weekly clients is this domain's rain-day cascade)*

**P0-5: Session lifecycle with late-cancel policy**
States: `scheduled → confirmed → arrived → in_session → completed | no_show | cancelled | late_cancelled`; cancellation inside the configurable window (default 24h) records as `late_cancelled` with the policy fee (chargeable flag only — no payment processing).
- [x] Late vs. advance cancellation is determined server-side from the injected clock, not by whoever clicks
- [x] No-show and late-cancel counts per client are visible to their clinician and practice manager, not front desk

**P0-6: Forms with scoring + risk thresholds** *(core learning artifact #3)*
Everything from the form builder (field types, conditional logic, versioned templates, tokenized resumable links) plus: numeric scoring rules per template (sum of mapped answer values), configurable total-score thresholds, and designated **critical items** whose flagged responses alert regardless of total score.
- [x] Given a screener submission crossing a threshold or flagging a critical item, when it saves, then the treating clinician receives an outbox-stubbed private alert and the submission is marked for review — visible to the treating clinician only
- [x] Scores and responses are clinical data: front desk sees "submitted ✓," never content or scores
- [x] A v1 submission renders against v1 after the template revises to v2 (no phantom fields, no lost answers); scoring rules version with the template
- [x] Consent forms capture a typed-name signature stub + timestamp; consent status drives the P0-3 banner

**P0-7: Two-tier clinical notes with co-sign** *(core learning artifact #4)*
Progress notes: draft → signed (→ co-signed when author is an associate); signed notes immutable, amendments append. Process notes: freeform, author-only, no signature workflow, still immutable-with-amendments.
- [x] An associate's signed progress note enters the supervisor's co-sign queue; the record shows "pending co-signature" until both signatures exist
- [x] Editing any signed note is impossible at the API level; the affordance becomes "amend"
- [x] Process notes never appear in any list, search, export, or report visible to anyone but their author

**P0-8: Reminder discretion** *(operator review — the detail outsiders miss)*
All outbox-stubbed client communications use neutral templates: "Appointment reminder: Tue 3:00 PM, Stillwater" — never "counseling," clinician specialty, or session type.
- [x] Template text is configurable but lint-tested against a deny-list of clinical terms
- [x] Reminder timing per client is settable to "none" (some clients want no messages at all)

### Nice-to-Have (P1)

- **P1-1: No-future-appointment queue** — clients whose last session completed ≥N days ago with nothing scheduled; front-desk work list with discreet outreach stubs
- **P1-2: Co-sign aging report** — supervisor view of pending co-signatures by age *(operator review: unsigned supervisee notes are a compliance clock)*
- **P1-3: Auditor query UI** — filter by client, actor, date, flagged-only; CSV export
- **P1-4: Waitlist** — clients wanting an earlier/standing slot; a cancellation surfaces matching waitlist candidates to front desk (no auto-booking)
- **P1-5: Utilization report** — sessions per clinician per week, room utilization %, late-cancel/no-show rates

### Future Considerations (P2)

- Superbill/CPT export hanging off the fee record
- Group sessions (one appointment, N clients — requires attendance-level notes)
- Longitudinal screener trends per client (clinician-only view; note the ethics in WRITEUP.md)
- Client portal (view schedule, reschedule requests) via tokenized links
- Two-factor auth for clinical roles (auth remains its own project; note the seam)

## Success Metrics (evaluated against synthetic seeded data)

**Leading**
- RBAC: 100% of the permission matrix asserted, including the supervisor-denied-process-note and break-glass-denied-process-note cells
- Audit completeness: a scripted session touching N records produces exactly the expected audit rows; DB-level tamper attempt fails
- Scheduling integrity: 0 double-bookings of clinician or room across the race suite; telehealth correctly exempt in 100% of fixture cases
- Recurrence: detached-instance regression passes; idempotent horizon runs create 0 duplicates
- Scoring: 100% of scoring fixtures match hand-calculated totals; every threshold/critical-item fixture produces exactly one alert to exactly one recipient

**Lagging (simulated)**
- A seeded quarter (6 clinicians, ~70 recurring clients, 1 clinician vacation, ~40 screener submissions incl. threshold cases, 3 break-glass events) yields an auditor report matching hand-tallied fixtures
- No-future-appointment queue matches hand-calculated continuity gaps

Measurement method: seed script with obviously-fake clients (Test Client 001…) and a scripted "practice quarter" simulator including the vacation-cascade event.

## Open Questions

- **(Builder)** Dev-mode user-switcher instead of real auth (per Chairside decision)? Yes — flagged in README. *(resolved)*
- **(Builder)** Alerts: in-app only or also outbox? Outbox stub to the clinician + in-app badge; never to any shared surface. *(resolved)*
- **(Product)** Can a client have two clinicians (individual + couples)? V1: one treating clinician per client record; couples modeling rides with group sessions in P2. *(resolved — note the limitation in README)*

## Timeline / Phasing

- **Phase 1:** P0-1, P0-2 (RBAC with sensitivity tiers + audit log) — before any feature; the two-tier note rule shapes everything downstream
- **Phase 2:** P0-3, P0-4, P0-5 (clients, recurring dual-resource scheduling, lifecycle)
- **Phase 3:** P0-6, P0-7, P0-8 (scored forms, two-tier notes + co-sign, discreet reminders)
- **Phase 4:** P1; capstone demo = the access story: supervisor co-signs an associate's progress note, then is denied the same client's process note, and the auditor traces both events

## Build Notes for Claude Code

- CLAUDE.md conventions: integer cents, injected clock, state-machine module, authorization only via the RBAC module, no PHI in logs/URLs — plus new: **process notes are author-only at every layer (query, API, export, search); treat any cross-author process-note access path as a P0 bug**, and **alert routing goes to the treating clinician only**
- TDD order: permission matrix (including the denial cells) → scoring rules → recurrence. All three are pure logic
- Drop WRITEUP.md + the write-up CLAUDE.md block at repo creation; Scope Honesty banner in README at commit one
- The 60-second demo is the co-sign-then-denial flow above — it shows in one take that this project is about layered confidentiality, not another calendar
