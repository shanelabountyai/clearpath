# Next

**First, the step that needs a person.** (P1-3's production migration ran before the push.)

1. **`CRON_SECRET` is still unset on Vercel** (carried). Both cron routes answer
   401 until it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item:** P1-4, "while you were away". It adds no new permission cell, so it is
Sonnet work.

## What just landed (P1-3, supervisor coverage)

- The review settled D-21 to D-24 in `prd-clinician-leave.md`. A supervision
  cover gains co-signing plus reads on the note, the client and the screener,
  for the window only and only from the supervisor role. `coveringSupervisorId`
  is required at the door for anybody who supervises. D-13 stands.
- `permissions.ts`: `authorSupervisorCoverage` and `treatingSupervisorCoverage`
  on `Target`; `supervisorOfAuthorOrCovering` for co-signing; the two covering
  read rules widened in place; `can()` names the leave for any of the three.
- `coverage.ts`: `supervisionCoverageOf` and `supervisionCoveredBy`, wired into
  `clientTarget`, `progressContext`, `caseloadWhere`, `listProgressNotes` and
  `coSignQueue` (one guarded read per leave). The note page uses `mayCoSign`.
- `leave-plan.ts`: the create door, `nameSupervisionCover`, and the plan
  screen's `supervisors` and `supervisionBlocked`. There is a Supervision card
  on `/leave/[id]` and a "Supervision cover" picker on `/leave`.
- WRITEUP §36 has a P1-3 entry and three decisions rows.

## Gate

The typecheck is clean. The unit tests passed: 3090 across 25 files in src/auth,
notes, clients, staff, forms, messaging, portal and scheduling, including both
source-grep guards. Three mutations were each caught by one red test. The e2e
run passed 14 of 14 (leave, leave-demo, confidentiality) against a fresh
production build.

## Loose threads

1. **New, from P1-3:** a departure executed while the leaver's supervisor is
   away hands its unassigned alerts to the absent supervisor, not to the cover.
   Listed under the PRD's risks.
2. **New:** the `listProgressNotes` audit row names the first leave a cover
   holds (`ponytail:`). The `/worklists` leave section does not count blocked
   supervision covers. The seed has no supervision-cover demo.
3. `delivery:run` and `nonresponse:run` have no scheduler, on purpose.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`. (The seed's own summary contains "failed" and
   "skipped", so a totals grep also fires on the seed.)
5. Design brief §5b/§5c components with no picture.
6. `executeDeparture`'s `ponytail:` 30s transaction budget.
7. Queued links use the stub's `http://localhost:3700`, now on the hourly cron too.
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. The capstone leave is dated from the real clock.
