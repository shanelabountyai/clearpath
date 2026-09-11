# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: a supervisor who departs after a supervisee did.** Alex departed and
Alex's discharged client's alert went to Sam (departure P0-7). When Sam departs,
`executeDeparture` repoints Alex's `supervisorId` to Sam's receiver. But it moves
only alerts about Sam's own caseload, so that alert stays with Sam's closed
account. `ownerOf`/`routesOf` in `src/staff/coverage.ts` already say where it
belongs. The likely fix is a reroute of the leaver's remaining unread alerts
after supervisees repoint, plus a blocker when there is nobody to take them.
This is alert routing (hard rule 9), so it is **Opus** work. It is recommended
over the supervision-cover follow-ups (loose thread 1) and a production reseed
(0); pick one of those instead if you prefer.

## What just landed (leave D-26, a departure while the supervisor is away)

- `coverage.ts`: `ownerOf` gives an alert's owner: the treating clinician, or a
  departed clinician's supervisor. `routesOf` covers the owner, by client
  (`coverageOf`) or by supervision (`supervisionCoverageOf`). `alertRecipient`,
  `executeDeparture`, the sweep and every `settleAlerts` write route through it.
  `nameSupervisionCover` now settles alerts too.
- Both orders are handled. A departure during the leave sends the alert to the
  cover, stamped, and the leave's end returns it to the supervisor. A leave that
  starts after the departure takes the alert on its first day. New alerts about
  a departed clinician's client no longer go to the closed account.
- A transferred client's alert reaches an away receiver's coverer inside the
  departure's transaction.
- The PRD has D-26 and a new risk line. WRITEUP §36 has the entry "A departure
  while the supervisor is away", and the decisions log has two rows.

## Gate

The typecheck is clean. The unit tests passed: 3199 across 32 files. Five
mutations were each caught by one red test. The e2e specs `departure-demo` and
`leave-demo` passed, 9 of 9, against a fresh production build.

## Loose threads

0. Production data predates confirmations, departures and leave, and now also
   lacks the covered session. A reseed is `npm run db:seed:prod`, about 25
   silent minutes, and it is your call. Run `db:migrate:prod` before pushing
   any migration.
1. `listProgressNotes`' audit row names the first leave a cover holds
   (`ponytail:`). `/worklists` does not count blocked supervision covers, and
   the seed has no supervision-cover demo. A supervisor away with no supervision
   cover still holds a departed supervisee's alerts (D-26 leaves it to D-22).
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
