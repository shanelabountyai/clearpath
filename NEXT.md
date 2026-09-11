# Next

**Item:** clinician leave, Phase 4: the leave plan screen (record, name the
coverer, split clients, early return), front desk's view, and P1-2 markers
(`prd-clinician-leave.md` v0.2). Then the capstone demo: the Lagging scenario
as a seeded leave and a spec, on an advanced clock.
Model: Sonnet fits the screens. Use Opus for P0-8's continuous coverer scan,
because it decides who is shown as able to cover.

## What just landed (Phase 3)

- `src/staff/coverage.ts`: `coverageOf` (which leave, which coverer),
  `routeOf`, `alertRecipient`. `clientTarget(clientId, clock)`,
  `progressContext`, `createProgressNote`, the client and appointment pages,
  and `caseloadWhere` all resolve through it. `permissions.ts` still decides
  the day (D-14).
- The caseload list admits covered clients with `may` per resolved target,
  scoped inside `AND` so a search's `OR` cannot overwrite it.
- `listProgressNotes` widens for the coverer by `can(...).coveringLeaveId`,
  never `allowed`, because break-glass passes the same cell.
- Both alert sites call `alertRecipient`. `runLeaveAlertSweep` (on
  `reminders:run`, settled) reconciles unread alerts to today's routing in one
  transaction. Migration `20260911135021_alert_covering_leave_index`, applied
  to dev, test and e2e.
- `guarded` writes `reason: 'leave:<id>'` when a decision rested on a leave.
- `clinicianCapacity`: `accepting` is derived, and `declared` is the
  clinician's own toggle (the inquiries page uses it).
- `leave_open` departure blocker. Execution refuses with that code.
- **D-18 (user decision):** early return may set `toDate` to yesterday ("back
  today"). The edit ends the leave and returns its unread alerts in the same
  transaction.
- WRITEUP §36 "Phase 3" subsection, seven decisions-log rows, and PRD D-18.

## Watch for

- **Date edits still do not re-check coverers.** P0-8's plan-screen scan: a
  coverer departing, going inactive, or on leave inside the window.
- **A mid-leave `decideCoverage` moves unread alerts only on the next sweep**,
  not in its own transaction. That is fine hourly. Decide whether the screen
  should do it on the spot.
- **Client page refusal copy** still says "treating clinician or supervisor",
  and the break-glass prompt does not mention coverage.
- **No scheduler runs `reminders:run` or `purge:run`**: neither appears in
  `vercel.json` or `.github`.

## Gate

Full unit sweep 3135/3135 before D-18. After D-18: typecheck clean and
`src/staff` 110/110 (`editLeaveDates` has no other caller yet). Nine mutations
checked, all red. e2e: 53 passed + 1 skipped = 54.

## Loose threads (carried)

1. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing, because the runner's command line has no project path.
2. Design brief §5b/§5c components with no picture. Still inventory.
3. `executeDeparture`'s `ponytail:` 30s transaction budget.
4. Queued links use the stub's `http://localhost:3700`.
5. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
