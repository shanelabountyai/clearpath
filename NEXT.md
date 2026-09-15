# Next

**First, the step that needs a person** (carried, and now visible).

1. **`CRON_SECRET` is still unset on Vercel.** All three cron routes answer 401
   until it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy. The check is no longer "read the platform log": open
   **/practice → Scheduled jobs** and the three badges should go from
   **Never run** to **Ran**, with counts and a timestamp, within the hour.

**Item: loose thread 7 — every queued link in production says
`http://localhost:3700`.** Four places build a client-facing URL and three of
them default to that stub; `src/staff/departure.ts:847` hardcodes it with no
override to pass. Every portal link, every form link and every reminder the
practice has queued in production carries a URL that resolves to nothing on the
client's phone — and two hourly crons now queue them on a schedule. Client-facing
and on the messaging path, so **Opus**:

    /model opus

## What just landed (loose thread 19)

- **The 500 was the smaller half.** The larger half was in this file the whole
  time: `CRON_SECRET` is unset, so the routes answer **401 — a *successful*
  HTTP response**. Three jobs have done nothing, hourly, for two days, and
  every instrument that exists reports them healthy. `WRITEUP.md` §42.
- **A monitor inside the thing that can fail is not a monitor.** Every real way
  these stop — a cron that never fires, a route turned away at the door, a
  function killed at its timeout — is a path on which no handler code runs. So
  the new `JobRun` table records **runs**, and the signal is **absence**: the
  last row per job, and how old it is.
- **`overdueAfter` is two ticks, not one.** These runners are documented as
  late-rather-than-wrong when missed, so one skipped hour is not news. Nothing
  that is running misses two.
- **The error's class name, never its message.** Hard rule 3 reaches the
  monitoring table: a Prisma error quotes the row that caused it. `TypeError`
  plus a timestamp is enough to know which log to open. A test throws an error
  carrying a client's name and asserts the name is nowhere in the row.
- **One name in three places.** `SCHEDULED`, `vercel.json` and `app/api/cron`
  are now held to the same list by the wiring test — a job recorded as `purge`
  and watched as `purges` is a green badge nothing is looking at.
- **The surface is a card on /practice**, next to the retention windows. It
  reads unguarded and writes no audit row, for the reason `may()` gives for
  staying silent, and is reached only after that page's own guard has run.
- **Deliberately not an alert**, and the `ponytail:` on `jobHealth` says so: the
  app has one outbound channel and it goes to clients. The missing piece is an
  operations channel, not the detection.
- **Two `ponytail:` remain in `src/`** — `public-inquiry.ts` and `inbound.ts`,
  plus the new one on `jobHealth`.

## Gate

Typecheck clean. **Unit suite: 32 files, 3214 passed, 0 skipped, exit 0.**
**e2e `denials`: 7 passed, exit 0** — that spec walks every static staff route
as every seeded person, so it is the one that proves the new card renders (and
does not 500) for all six roles.

Migrations applied to dev, test and e2e. `npm run db:migrate:prod` is still
manual before the next push.

**No full e2e sweep, and no `npm run shots`.** No screenshotted page changed —
`/practice` appears in no README picture.

Carried from before: **run long sweeps as tracked background tasks and re-run
on a 137 before investigating anything**, and `dotenv` bare is Python — use
`./node_modules/.bin/dotenv`.

## Loose threads

1. ~~`listProgressNotes`' audit row names the first leave a cover holds.~~
   Landed 2026-09-15.
2. ~~P1-4 lists nothing for a returning supervisor.~~ Landed 2026-09-14.
3. ~~`delivery:run` and `nonresponse:run` have no scheduler.~~ Landed
   2026-09-15.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`, and a totals grep must anchor on
   `^ *N passed` because the seed's summary contains "failed". Arm the monitor
   *after* the redirect has created the log file.
5. ~~§5c's ten uncaptured screens.~~ Landed 2026-09-15. `WRITEUP.md` §41.
6. ~~`executeDeparture`'s `ponytail:` 30s transaction budget.~~ Landed
   2026-09-15.
7. **Queued links use the stub's `http://localhost:3700`**, on two hourly crons.
   `portal/service.ts:101`, `forms/service.ts:117`, `scheduling/reminders.ts:172`
   default to it; `staff/departure.ts:847` hardcodes it. **This is the next
   item.**
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. **Three of the seed's stories are dated from the real clock** — the capstone
   leave, Rosa's, and Anders'. Cause **unknown**: one `shots` run produced a
   `calendar-front-desk.png` differing from `HEAD` in exactly one cell (a
   *confirmation state*), and the re-run reproduced `HEAD` byte-for-byte. Worth
   one look if it recurs.
10. An alert the leaver holds only as a *coverer* on somebody else's leave still
    blocks their departure (D-31 risk line).
11. D-26's routing (a departed clinician's alert reaching their supervisor's
    cover) still has no seeded picture.
12. Seven clinicians in the seed, so a new leave still collides with a spec
    that names one. Locate rows by their link, not by a name.
13. ~~No seeded picture of a returning supervisor.~~ Landed 2026-09-15.
14. The dismissal has no undo.
15. The gallery coverage test knows a component's name appears in
    `app/design/page.tsx`, not that the specimen shows anything useful.
16. §5b's loading and error states have nothing to photograph. Argued in
    `WRITEUP.md` §41 — a feature, not a picture.
17. §5b's screener result card, co-sign ageing row, audit row and form fields
    are inline page markup, not primitives, so the gallery cannot import them.
18. **"While you were away" is four lists rendered as one flat list**, ordered
    by kind rather than by date.
19. ~~No cron run is monitored.~~ Landed 2026-09-15. `WRITEUP.md` §42.
20. `fee-disclosure-es.png` is a 390×844 frame whose lower third is empty,
    deliberately — the emptiness is part of what the picture claims.
21. **`JobRun` has no retention sweep.** ~17.5k rows a year, so nothing is
    urgent, and it was left out on purpose: a purge that trims the table
    watching the purge can destroy the evidence that the purge stopped. If it
    ever needs one, the safe shape is a floor — keep the last N per job
    regardless of age — not a window.
