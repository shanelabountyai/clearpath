# Next

**Item:** review `prd-clinician-leave.md` (Draft v0.1), then build Phase 1.
Opus fits: the phase is permission-matrix cells and new coverage rules.

## What just landed

- `prd-clinician-leave.md`, a draft PRD. Nothing is built yet, by choice
  (2026-09-10): the PRD comes first and is reviewed before any code.
- The departure PRD's P2 "Leave of absence" bullet points at it.

## The review should settle

1. D-02, access derived from dates plus the clock (no grant/revoke writes).
   Everything else depends on it.
2. D-03, one required coverer per leave with per-client overrides, which
   deliberately departs from departure D-13.
3. D-04, which five cells widen for the coverer.
4. Open Questions: routine sessions vs crisis only; whether supervisor
   coverage (P1-3) should be P0.

## Then Phase 1 (pure logic, TDD)

`leavePhase`, the `leave` matrix row with every denial, the three coverage
rules with boundary-day tests, process-note denials, and the fail-closed test.

## Gate

Unchanged from the previous commit (docs only). Last runs: 2920/2920 unit,
53 + 1 skipped = 54 e2e.

## Loose threads (carried)

1. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing, because the runner's command line has no project path.
2. Design brief §5b/§5c components with no picture. Still inventory.
3. `executeDeparture`'s `ponytail:` 30s transaction budget.
4. Queued links use the stub's `http://localhost:3700`.
5. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
