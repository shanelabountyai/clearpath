# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: the supervision-cover follow-ups** (loose thread 1). `/worklists` does
not count blocked supervision covers, and the seed has no supervision-cover
demo, so the D-26/D-31 routing has no seeded picture. Screen-and-seed work, not
safety-critical: **Sonnet** is enough, on `opusplan` if you want the plan read
first. A production reseed (0) or P1-4's returning supervisor (2) are the
alternatives; pick one of those instead if you prefer.

## What just landed (departure D-31, the alert a second departure could not see)

- The per-assignment alert move is gone from `executeDeparture`'s loop. Every
  unread alert still addressed to the leaver is rerouted in one pass after the
  caseload has moved, the supervisees have repointed and the account has closed,
  so `routesOf` reads the practice as it stands instead of a projection of it.
- `blockersOf` asks the same question thirty days early, where a projection is
  unavoidable: `afterDeparture` applies the three moves to one client's routing
  facts, and `strands` blocks when the route names nobody — the leaver, or a
  treating clinician who has departed with no supervisor above them. That
  replaces the old "leaver has no supervisor" test, and naming a receiving
  supervisor now clears an inherited alert the old scan could not.
- The PRD has D-31 and a risk line (a departing *coverer* still blocks rather
  than moving; the fix is on that leave). WRITEUP §37 is the entry, §36's "what
  it does not do" bullet that named this bug is struck through, and the
  decisions log has two rows.

## Gate

Typecheck clean. Unit: 3201 passed across 32 files (3199 + 2 new). Three
mutations each red — `strands` forgetting the departed clinician,
`afterDeparture` not repointing a supervisee, and the reroute running before the
supervision repoint. e2e `departure-demo` and `leave-demo`: 9 of 9 on a fresh
production build.

## Loose threads

0. Production data predates confirmations, departures and leave, and now also
   lacks the covered session. A reseed is `npm run db:seed:prod`, about 25
   silent minutes, and it is your call. Run `db:migrate:prod` before pushing
   any migration.
1. `listProgressNotes`' audit row names the first leave a cover holds
   (`ponytail:`). `/worklists` does not count blocked supervision covers, and
   the seed has no supervision-cover demo.
2. P1-4 lists nothing for a returning supervisor (co-signatures a cover gave),
   and has no dismissal; it drops off after 14 days.
3. `delivery:run` and `nonresponse:run` have no scheduler, on purpose.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`, and a totals grep must anchor on
   `^ *N passed` because the seed's summary contains "failed".
5. Design brief §5b/§5c components with no picture.
6. `executeDeparture`'s `ponytail:` 30s transaction budget.
7. Queued links use the stub's `http://localhost:3700`, now on the hourly cron too.
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. The capstone leave is dated from the real clock.
10. An alert the leaver holds only as a *coverer* on somebody else's leave still
    blocks their departure rather than moving (D-31 risk line). The fix is on
    that leave — name another cover, or end it.
