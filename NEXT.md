# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: P1-4's returning supervisor** (loose thread 2). "While you were away"
lists nothing for a supervisor coming back — the co-signatures their cover gave
in the window — and it has no dismissal; it drops off after 14 days. The seed
now has exactly that picture (Rosa away, Dev countersigning), so the screen has
something to show the moment it is written. Screen work over an existing query:
**Sonnet**. A production reseed (loose thread 0) is the alternative; it is
overdue by two features and is a 25-minute silent run.

## What just landed (the supervision-cover follow-ups)

- `leaveWorklist` returns `supervisionBlocked`, the same question
  `getLeavePlan` asks (P1-3): a supervision cover who could not cover, or
  nobody named for somebody who supervises anyone. `/worklists` shows it as its
  own "supervision uncovered" badge and withholds the "covered" tick, because
  it is a different sentence with a different fix than a coverer who cannot
  cover. The cover rides along in the one `unavailableCoverers` scan rather
  than earning a second round trip, and the coverer count filters back down to
  the coverers the leave actually named.
- The seed has a supervision cover: Rosa away from the real today for a week,
  **Tom** on her clients and **Dev** on her supervision — two different people
  on purpose — and Dev countersigns the oldest of Priya's waiting notes. Dated
  from the real clock like Hana's, so it is on while the specs run.
- `leave.spec.ts` found its own leave row with a bare `hasText: 'Tom
  Bergqvist'`, which now matches Rosa's row too. It filters by the row's own
  link instead. Same defect the decisions log already records for the co-sign
  queue: a row located by a name it merely mentions.
- PRD: the P1-5 bullet, and a risk line saying the seeded cover is a leave and
  not a departure. WRITEUP decisions log has one row.

## Gate

Typecheck clean. Unit: 3202 passed across 32 files (3201 + 1 new). Two
mutations red — `supervisionBlocked` hardcoded false, and the coverer count
absorbing the supervision cover. Full e2e sweep on a fresh production build:
62 passed, 1 skipped (the README capture, which wants `SHOTS=1`), 63 of 63.

## Loose threads

0. Production data predates confirmations, departures, leave, the covered
   session and now the supervision cover. A reseed is `npm run db:seed:prod`,
   about 25 silent minutes, and it is your call. Run `db:migrate:prod` before
   pushing any migration.
1. `listProgressNotes`' audit row names the first leave a cover holds
   (`ponytail:`).
2. P1-4 lists nothing for a returning supervisor (co-signatures a cover gave),
   and has no dismissal; it drops off after 14 days. **This is the next item.**
3. `delivery:run` and `nonresponse:run` have no scheduler, on purpose.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`, and a totals grep must anchor on
   `^ *N passed` because the seed's summary contains "failed".
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
