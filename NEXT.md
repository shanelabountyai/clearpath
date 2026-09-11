# Next

**Item:** leave P1-5 and P1-1 on `/worklists`: upcoming and active leaves,
coverer blockers (the `unavailableCoverers` scan), and the count of unread
alerts that move when a leave starts; plus the uncovered-absence count (an
alert raised for a clinician whose active `unavailable` override has no leave
behind it — Nour's seeded annual leave is exactly that). Counts only, never a
client (departure D-25).
Model: Sonnet fits. Both are counts over reads that already exist.

Alternatives if the leave P1s can wait: a scheduler for `reminders:run` and
`purge:run` (nothing runs either; see loose threads), or P1-3 supervisor
coverage, which needs its own review first (D-17) — Opus for that one.

## What just landed (Phase 4 + capstone)

- `/leave` (front desk's view, record form) and `/leave/[id]` (split clients,
  name coverer, move dates, "back today", cancel). `getLeavePlan`,
  `listLeaves` in `src/staff/leave-plan.ts`.
- P0-8's continuous scan: `unavailableCoverers` is the door check and the
  screen's scan and the pickers' filter, one function.
- **D-19:** every leave write moves that leave's unread alerts in its own
  transaction (`settleAlerts`). The sweep keeps only the date boundaries.
- P1-2 markers: "you cover until" on the caseload list; "X away until … ·
  covering: Y" on the record, per client.
- Audit log filters on an exact `reason`; code-shaped reasons link to it.
- Capstone: seeded Hana Lindqvist on leave, dated from the real clock (own
  therapist, like Maren); `e2e/leave-demo.spec.ts` walks it.
- Seed walks past sessions in a total order `(startAt, client code)`. It
  crashed once on a duplicate reminder row from tie order.
- `orBack` moved to `departures/ui.tsx`: a `'use server'` export is an endpoint.

## Gate

Unit 3143/3143 before the audit filter; reports 54/54 after. Typecheck clean.
Four mutations, all red. e2e full sweep 61 passed + 1 skipped + 1 failed = 63;
the failure was the capstone's process-note assertion (wrongly scoped to the
client, not the note), fixed, and `leave-demo.spec.ts` rerun 5/5.

## Watch for

- **The capstone leave is dated from the real clock** at seed time. A sweep
  started just before midnight and running past it could see "back today" land
  on a leave whose dates have shifted by a day.
- **Hana's leave is active during the whole e2e sweep**, so Dev's caseload and
  alerts include TC-086/087 for every spec that signs in as Dev.

## Loose threads (carried)

1. **No scheduler runs `reminders:run` or `purge:run`**: neither is in
   `vercel.json` or `.github`.
2. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing. An e2e alarm must also match `Error:`, or a seed crash before the
   first test passes silently (it did once this session).
3. Design brief §5b/§5c components with no picture. Still inventory.
4. `executeDeparture`'s `ponytail:` 30s transaction budget.
5. Queued links use the stub's `http://localhost:3700`.
6. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
