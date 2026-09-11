# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: a departure while the leaver's supervisor is away.** `executeDeparture`
hands unacknowledged alerts with no receiver to the leaver's supervisor
(departure P0-7). If that supervisor is on a leave with a supervision cover,
those alerts go to the person who is away, not to the cover. Listed under the
leave PRD's risks. It touches alert routing (hard rule 9), so it is **Opus**
work. Chosen 2026-09-11 over the supervision-cover follow-ups and a production
reseed.

## What just landed (leave P1-4, "while you were away")

- `leave-plan.ts`: `recentlyBack` finds the actor's own leave that ended in the
  last 14 days, and asks the matrix first. `whileYouWereAway` makes three
  treating reads in one `guardedAll`: flagged submissions (filtered on
  `FormRequest.submittedAt`), sessions somebody else held, and progress notes
  somebody else wrote about sessions in the window. It never reads process notes.
- Home redirects a recently returned clinician to `/worklists`. The "While you
  were away" section there comes first.
- Seed: Dev holds and writes up a session for TC-086 on day two. The
  leave-demo spec checks Hana's first screen back.
- D-25 in the PRD, WRITEUP §36 P1-4 entry, and two decisions-log rows.

## Gate

The typecheck is clean. The unit tests passed: 3092 across 25 files, including
both source-grep guards. Six mutations were each caught by one red test. The
e2e run passed 14 of 14 (leave, leave-demo, confidentiality) against a fresh
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
