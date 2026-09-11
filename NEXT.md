# Next

**Item:** clinician leave, Phase 2: schema (`prd-clinician-leave.md` v0.2).
Opus fits: exclusion constraint, CHECKs, and audit in the same transaction.

## What just landed

- Review settled D-14 to D-17 (2026-09-10). The date check lives in
  `permissions.ts`, a supervisor's `leave.update` is a grant, the coverer gets
  all five cells, and supervisor coverage stays P1.
- Phase 1: `src/staff/leave.ts` (`leavePhase`), the `leave` matrix row, the
  `covers` rule and three rules built on it, `Target.coverage`/`today`,
  `Decision.coveringLeaveId`, process-note denials, fail-closed tests, and
  WRITEUP §36. Mutation-checked: removing the toDate compare, the phase
  check, the `today` guard or the associate refusal each turns tests red.

## Phase 2 scope

`Leave`, `LeaveCoverage`, `leave_no_overlap` (gist on a daterange where not
cancelled), the CHECKs (`toDate >= fromDate`, coverer is not the person away),
`Alert.coveringLeaveId`, and the `AvailabilityOverride` written in the same
transaction. Every write audit-logged. Constraints asserted against a real
connection. D-13's coverer check at the door: `mayTreat` plus
`!requiresCoSignature`, asked of the matrix and never of a role name.

## Watch for

- **Keep `src/staff/leave.ts` import-free.** `permissions.ts` imports it, so
  a guard or db import there is a cycle through every request. Put the
  service in its own file.
- **The rule names in audit rows changed** for five cells, for every reader.
  Nothing in `src`, `app`, `e2e` or `scripts` matched on the old names.
- **Phase 3's resolver test** must show a `LeaveCoverage` override beating the
  leave-level coverer. In pure logic it is only "the id on the target".
- **Early return** is refused below `fromDate` by the CHECK. The PRD's
  "shorten to today" rule already avoids that case; keep it.

## Gate

3098/3098 unit, typecheck clean. e2e not rerun: no spec touched, and no
call site passes `coverage` yet. Last e2e: 53 + 1 skipped = 54.

## Loose threads (carried)

1. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing, because the runner's command line has no project path.
2. Design brief §5b/§5c components with no picture. Still inventory.
3. `executeDeparture`'s `ponytail:` 30s transaction budget.
4. Queued links use the stub's `http://localhost:3700`.
5. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
