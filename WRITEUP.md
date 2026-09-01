# Clearpath — build notes

Kept as the work happens, not reconstructed afterwards.

## Core learning artifacts

1. **RBAC with sensitivity tiers** — two classes of clinical note with
   different, deliberately asymmetric rules.
2. **Recurring dual-resource scheduling with a conditional resource** — clinician
   + room, except telehealth needs no room.
3. **Scored dynamic forms with risk thresholds** — versioned templates, scoring
   rules that version with them, critical items that alert regardless of total.
4. **Two-tier notes with supervisory co-signature.**

---

## 1. RBAC with sensitivity tiers

**The problem.** Access in a counseling practice is not a ladder. A supervisor
outranks an associate on the official record — they must co-sign it — and has
*less* access than that associate to the associate's private process notes,
where the answer is never. A practice manager administers the whole business and
cannot read a session note without breaking glass, and cannot read a process note
even then. Any model where "more senior" implies "sees more" gets this wrong.

**The design.** One declarative `MATRIX: role × resource × action → rule`. Cells
absent from the matrix deny. Rules are five named predicates over the actor and
the *relationships* of the thing being touched (`author`, `authorOrSupervisor`,
`supervisorOfAuthor`, `treating`, `breakGlass`); relationships are resolved from
data by the caller, so reassigning an associate's supervisor in the database
immediately reroutes both read access and the co-sign queue with no code change.

Two decisions worth naming:

- **`process_note` and `progress_note` are separate resources, not one resource
  with a sensitivity flag.** A flag invites `if (note.private)` checks scattered
  across call sites; separate resources put the difference in the policy table
  where it is visible and testable. The supervisor's row reads
  `progress_note: { cosign: ... }` next to `process_note: { read: 'author' }` —
  the asymmetry is legible at a glance.
- **`can()` returns a `Decision`, not a boolean.** It carries which rule fired
  and whether the actor was in a break-glass session, because the audit log
  needs both, and denials must be logged as richly as grants. A boolean would
  have forced every call site to re-derive that context.

**Front desk is modelled by resource, not by field.** "Sees the calendar but not
why anyone is there" could be a field-level projection on a client record; it is
instead separate resources (`client` vs `form_submission`, `form_request` vs
`form_submission`, `attendance_history` split out from `client`). Field-level
redaction is a filter you can forget to apply. A missing matrix cell is a 403.

**What it does not do.** No hierarchy, no role inheritance, no per-record ACLs,
no delegation. `associate` and `therapist` share an identical matrix — the
co-signature requirement is a workflow gate in the note state machine, not a
permission — and modelling it as a permission would have been the intuitive
wrong answer.

**Test approach.** All 330 cells are enumerated and asserted, but the expected
policy is hand-written from the PRD rather than read back off the matrix, so the
suite cannot agree with a wrong edit. Each cell is probed three ways: an actor
holding every relationship *and* break-glass, an actor who supervises the author
but wrote nothing, and an actor with no relationship at all. That last probe is
what proves which permissions are unconditional.
