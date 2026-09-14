# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: a production reseed** (loose thread 0). Production data now predates
confirmations, departures, leave, the covered session, the supervision cover
and P1-4's supervision list — six features with no picture on the deployed
site. `npm run db:seed:prod`, about **25 silent minutes**, and it needs
`db:migrate:prod` first because this session added a migration
(`20260914144828_leave_back_dismissed`). No model question; it is a run, not a
build. The alternative is loose thread 5 (design brief §5b/§5c components with
no picture) — screen work, **Sonnet**.

## What just landed (P1-4's returning supervisor, and a dismissal)

- `whileYouWereAway` gives a supervisor a fourth list: the countersignatures
  their supervision cover gave in the window. Its own request in the same
  `guardedAll`, on `{ authorSupervisorId: actor.id }` — the co-sign queue's
  cell — and asked for only when the person has supervisees, so a therapist
  back still makes exactly three audit rows and a supervisor makes four.
- `Leave.backDismissedAt` reverses D-25's "nothing is written on return". The
  fortnight stays as the backstop. It sits on `recentlyBack`, so it also stops
  Home landing the person on `/worklists`. Self-scoped by the query, not by a
  new cell: a clinician holds no `leave.update`, and on this feature that cell
  IS the coverage grant.
- `/worklists` gets the fourth list and an "I have read this" button; the
  existing leave-demo spec clicks it after bringing Hana back.
- PRD D-27 and the P1-4 bullet; WRITEUP §P1-4 has the new design section and
  one decisions-log row.

## Gate

Typecheck clean. Unit: 3204 passed across 32 files (3202 + 2 new). Six
mutations red — the window, "anybody but me", the supervisee filter, the
supervision audit door, the dismissal on read, and the dismissal's self-scope.
Full e2e on a fresh production build: 62 passed, 1 skipped, 63 of 63.

**Two mutations were green first**, and both for the same reason: a fixture the
neighbouring filter already excluded. The out-of-window countersignature was
given by the person coming back, so `not: actor.id` hid it and the window was
never tested; the in-window one on a non-supervisee was never countersigned at
all, so `coSignedAt` hid it and the supervisee filter was never tested. A
negative fixture has to fail exactly one filter.

## Loose threads

0. Production data predates six features now. A reseed is `npm run db:seed:prod`
   after `db:migrate:prod`, about 25 silent minutes, and it is your call.
   **This is the next item.**
1. `listProgressNotes`' audit row names the first leave a cover holds
   (`ponytail:`).
2. ~~P1-4 lists nothing for a returning supervisor, and has no dismissal.~~
   Landed 2026-09-14.
3. `delivery:run` and `nonresponse:run` have no scheduler, on purpose.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`, and a totals grep must anchor on
   `^ *N passed` because the seed's summary contains "failed". **New this
   session:** arm the monitor *after* the redirect has created the log file —
   `tail -f` on a path that does not exist yet dies instantly and the sweep
   then runs unwatched.
5. Design brief §5b/§5c components with no picture.
6. `executeDeparture`'s `ponytail:` 30s transaction budget.
7. Queued links use the stub's `http://localhost:3700`, now on the hourly cron too.
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. The capstone leave is dated from the real clock. So is Rosa's.
10. An alert the leaver holds only as a *coverer* on somebody else's leave still
    blocks their departure rather than moving (D-31 risk line). The fix is on
    that leave — name another cover, or end it.
11. D-26's routing (a departed clinician's alert reaching their supervisor's
    cover) still has no seeded picture: the seed's one departure is planned,
    not executed, and executing it would spend the departure demo.
12. Only five clinicians in the seed, so every new leave collides with a spec
    that names one of them. The fix each time is a locator that finds the row
    by its link, not by a name it mentions.
13. **No seeded picture of a returning supervisor.** Rosa's supervision cover
    runs from the real today forward, so she is away, not back — the new list
    is unit-tested but has nothing on the deployed site until her leave ends.
    Ending it in a spec would spend the supervision-cover badge demo, the same
    trade as 11.
14. The dismissal has no undo. One row per leave, and restoring the section
    means recording the leave again.
