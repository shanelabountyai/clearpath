# Next

**First, the scheduler's one outstanding step (a person has to do it).**
`CRON_SECRET` is not set on the Vercel project. The auto-mode classifier
refused the `vercel env add`. Until it is set, both cron routes answer 401 on
every call, so nothing runs.

    openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

Then redeploy production, because env changes take effect only on a new
deployment. After the next hour mark, check that `/api/cron/reminders`
returned 200 in the Vercel logs.

**Item:** P1-3 supervisor coverage. It needs its own review first (D-17), so
use Opus. Or P1-4, "while you were away", which is Sonnet work.

## What just landed (the scheduler)

- `src/jobs.ts` holds `remindersRun`, `purgeRun` and `cronAuthorized`. The npm
  scripts and `app/api/cron/{reminders,purge}/route.ts` both call the runners,
  so the two doors cannot drift apart.
- `vercel.json` crons: reminders `0 * * * *`, purge `0 8 * * *` (UTC).
- `cronAuthorized` fails closed when the secret is unset, and compares
  digests in constant time.
- WRITEUP has a scheduler entry and a decisions row. README and `.env.example`
  are updated.

## Gate

The typecheck is clean. `npm run build:e2e` compiled both routes. 2644 tests
passed across 7 files: jobs, permissions and notes/service (the source-grep
guards), plus reminders, leave-plan, inquiry and departure. The full unit sweep
did not run, because the classifier refused a backgrounded run. One mutation,
dropping the `!secret` guard, was caught by 2 tests. `npm run reminders:run`
ran on dev and printed `queued 15, promoted 12, exempted 0, alerts moved 0`.
There was no curl against a served build.

## Loose threads (carried)

1. **`delivery:run` and `nonresponse:run` have no scheduler, on purpose.**
   Fees depend on both. Scheduling them is a product decision, not wiring.
2. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing. An e2e alarm must also match `Error:`.
3. Design brief §5b/§5c components with no picture. Still inventory.
4. `executeDeparture`'s `ponytail:` 30s transaction budget.
5. Queued links use the stub's `http://localhost:3700`, and now on the hourly
   cron too.
6. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
7. The capstone leave is dated from the real clock, so a sweep that runs past
   midnight can shift "back today".
