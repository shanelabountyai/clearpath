# Next

**Item:** clinician leave, Phase 3: wiring (`prd-clinician-leave.md` v0.2).
Opus fits: resolution decides clinical access at every call site.

## What just landed

- Phase 2: `Leave`, `LeaveCoverage`, `Alert.coveringLeaveId` (migration
  `20260911125525_clinician_leave`, applied to dev, test and e2e).
  `leave_no_overlap` (gist, inclusive `daterange`, not cancelled),
  `leave_ends_after_it_starts`, `leave_coverer_is_not_away`,
  `leave_calendar_row_while_live` (`overrideId` set exactly while not
  cancelled, `Restrict`), and the `leave_coverage_coverer_is_not_away`
  trigger. All asserted against a real connection.
- `src/staff/leave-plan.ts`: `createLeave`, `nameCoverer`, `decideCoverage`,
  `editLeaveDates`, `cancelLeave`. Each is one `guarded` transaction with the
  override and the audit row. `TRANSITIONS` (`upcoming → cancelled` only) is in
  `leave.ts`, which is still import-free. `mayTreat` is now exported from
  `departure.ts`.
- WRITEUP §36 "Phase 2" subsection, plus five decisions-log rows.

## Phase 3 scope

Coverage resolution in `clientTarget` and `caseloadWhere`, and every
hand-built target (grep `treatingSupervisorId:`). Then `alertRecipient` at both
alert-creation sites, the boundary sweep, derived capacity
(`acceptingNewClients && !onLeave(today)`), `reason: 'leave:<id>'` on
coverage-decided reads, and the `leave_open` departure blocker.

## Watch for

- **The resolver test** must show a `LeaveCoverage` row naming Kai beating the
  leave-level coverer.
- **Early return's alert move.** P0-5 says the `toDate` edit performs the
  "ends" alert move in its own transaction. `editLeaveDates` does not do it
  yet.
- **Date edits do not re-check coverers.** Only a named coverer is refused at
  the door. An extension into the coverer's own leave or departure is for the
  Phase 4 plan-screen scan.
- **`Alert.coveringLeaveId` has no index.** Add one in the migration that
  makes the sweep query on it.
- **Runner for the sweep** (`purge:run` or `reminders:run`) is still an open
  question in the PRD. Settle it in this phase.

## Gate

3122/3122 unit (3098 + 24 new), typecheck clean. e2e not rerun: no spec
touched, new columns are nullable, and nothing calls the service yet. The e2e
database is migrated. Last e2e: 53 + 1 skipped = 54.

## Loose threads (carried)

1. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing, because the runner's command line has no project path.
2. Design brief §5b/§5c components with no picture. Still inventory.
3. `executeDeparture`'s `ponytail:` 30s transaction budget.
4. Queued links use the stub's `http://localhost:3700`.
5. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
