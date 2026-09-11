# Next

**Item:** a scheduler for `reminders:run` and `purge:run`. Neither is in
`vercel.json` or `.github`, so nothing runs them. The leave boundary sweep
rides on `reminders:run`, and the new `/worklists` badge "N unread alerts not
yet moved" is exactly what a missing sweep looks like.
Model: Sonnet fits. It is cron wiring plus an auth check on the route. Opus is
worth it only if a cron endpoint needs a new secret design.

Alternative: P1-3 supervisor coverage. It needs its own review first (D-17), so
use Opus for it. Or P1-4, "while you were away", which is Sonnet work.

## What just landed (leave P1-1 + P1-5)

- `leaveWorklist` in `src/staff/leave-plan.ts`: one row per leave not yet over,
  counts only. Each row gives the caseload, how many named coverers cannot
  cover (`unavailableCoverers`), and the unread alerts still with the person
  away. `waitingWith` is shared with `settleAlerts`.
- `uncoveredAbsenceAlerts`: unread alerts to a recipient with an `unavailable`
  override active today and no leave behind it. Reads on `leave.read`, and the
  page shows it to `leave.create` (D-20).
- `/worklists` has a "Somebody is away" section. WRITEUP has a P1-5/P1-1 entry,
  and the PRD has its status and D-20.
- The seeded Nour absence starts 14 days out, so today's uncovered count is 0.
  The line appears only while a bare absence is active today.

## Gate

All 3146 unit tests pass and the typecheck is clean. Four mutations, all
caught: without the bare-override filter, without the kind filter, without the
unread filter, without the today filter. The today filter first survived; the
test now has a recipient whose absence starts later. e2e covered
`leave-demo.spec.ts` and `scheduling.spec.ts`: 14 passed, 0 skipped, 0 flaky,
out of 14. No full sweep this item.

## Loose threads (carried)

1. **No scheduler runs `reminders:run` or `purge:run`** (the item above).
2. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing. An e2e alarm must also match `Error:`.
3. Design brief §5b/§5c components with no picture. Still inventory.
4. `executeDeparture`'s `ponytail:` 30s transaction budget.
5. Queued links use the stub's `http://localhost:3700`.
6. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
7. The capstone leave is dated from the real clock, so a sweep that runs past
   midnight can shift "back today".
