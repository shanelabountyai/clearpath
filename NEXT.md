# Next

**Item:** Phase 2 of the departure PRD — the schema. `Departure`,
`DepartureAssignment`, `abandoned`, `unreachableSince`, the trigger, the audit
rows. Opus.

## What just landed (Phase 1, committed)

Pure logic only, per CLAUDE.md's TDD order. Three things:

1. **`departure` resource + `depart` action** (P0-3). Matrix column: admin
   `read create update depart`, supervisor `read update`, front desk `read`,
   therapist/associate `read: self`, auditor/client/public nothing. **No
   break-glass cell anywhere** — asserted by running every role × action twice,
   with and without a reason typed, and requiring the two answers to match.
2. **`progress_note.read` widened** to `authorSupervisorOrTreating` (P0-5,
   D-04) — author, supervisor-of-author, current treating clinician. Deliberately
   NOT the supervisor of the treating clinician. `process_note` untouched, and
   the paired assertion (same reader, same client, opposite answers) is in
   `permissions.test.ts`.
3. **`src/staff/departure.ts`** (P0-2) — `planned → executed | cancelled`, both
   terminal, `assertTransition` throwing `Conflict('…', 'bad_transition')`,
   the same code `scheduling/lifecycle.ts` uses.

D-15 recorded in the PRD, its Open Question struck: the rule is
`authorSupervisorOrTreating`, not `recordReader`. WRITEUP §29 written as it
landed, with eight decisions-log rows.

## The one thing to fix early, and it is not cosmetic

**The widening is not reachable at runtime yet.** Two call sites are narrower
than the policy now says:

- `src/notes/service.ts:29` `progressContext()` builds its target from the note
  alone (`authorId`, `authorSupervisorId`) and never resolves the client's
  current `treatingClinicianId`. This is the shared helper behind read, update,
  sign, cosign and amend — one edit covers all five.
- `src/notes/service.ts:179` `listProgressNotes()` scopes its SQL to
  `authorId: { in: [self, ...supervisees] }`.

Both are correct for yesterday's rule. `clients/repository.ts:250` already
passes `clinicianId` and needs nothing. WRITEUP §29's last section says this
out loud; do not let it rot. It is a Phase 3 edit in the PRD's phasing, but it
is the smallest thing that makes D-04 true rather than commented.

## Gate

**Green at this commit.** Unit **2861/2861** (28 files, 35.7s), typecheck clean.
No lint script in this repo. e2e not run — nothing UI-facing changed and the
new rule is unreachable at runtime, so there is no behaviour for a spec to see;
run it before Phase 3 lands, not before Phase 2.

Cell count went 896 → 1,088, suite 2,455 → 2,861. That is the matrix test doing
its job; fill cells, never narrow it.

## Loose threads

1. Public form's throttle read-then-write race. `ponytail:` comment. Still not
   worth a lock at three an hour.
2. A clinician on *leave* (not departing) with their books left open — still no
   mechanism, still P2.
3. Design brief §5b/§5c components with no picture. Still inventory.
