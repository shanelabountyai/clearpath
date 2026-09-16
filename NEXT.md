# Next

**First, the steps that need a person** (carried, and one new).

1. **`CRON_SECRET` is still unset on Vercel.** All three cron routes answer 401
   until it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy. Check: **/practice → Scheduled jobs**, the three badges go
   from **Never run** to **Ran** within the hour.

2. **Production's existing outbox rows still say `http://localhost:3700`.** The
   fix stops new ones; it does not rewrite rows already queued. Nothing sends
   (the outbox is the stub), so this only affects what the demo *shows*.
   Re-seeding fixes it — `npm run db:seed:prod`, ~25 silent minutes, do not kill
   it. Your call whether the demo needs it.

   Nothing to set for the fix itself: on Vercel `clientUrl` falls back to
   `VERCEL_PROJECT_PRODUCTION_URL` (the custom domain). `CLEARPATH_BASE_URL` is
   now in the local `.env.production` and `.env.e2e`.

**Item: loose thread 18 — "While you were away" is four lists rendered as one
flat list, ordered by kind rather than by date.** A presentation/ordering change
on one screen with an existing test file, so **Sonnet**:

    /model sonnet

## What just landed (loose thread 10)

- **The block itself was right and stays** (PRD risk line, `WRITEUP.md` §37): a
  leaver holding an alert only as somebody's cover is refused, and naming
  another cover clears it.
- **What was wrong was the date the scan asked about.** `blockersOf` routed on
  *today*, up to thirty days early. A cover whose last day falls after the leave
  ends was blocked for weeks by an alert the sweep would already have sent home,
  with nothing on any screen able to clear it. It now routes on the later of
  today and the last day, which is what execution routes on (D-30).
- **The leave screen disagreed on the boundary day.** `unavailableCoverers`
  used `lastDayOn < toDate`, so a cover leaving *on* the leave's last day was
  "fine" there while the departure was blocked. Now `lte`: the departure moves
  the last day's sessions.
- Two tests in `coverage.test.ts`, one per side, both red before the change.
  `WRITEUP.md` §44, two decision rows, and a note on the PRD risk line.

## Gate

Typecheck clean. **Unit suite: 32 files, 3225 passed (+2), 0 skipped, exit 0.**
No UI change, no migration, and no seeded departure involves a cover, so no e2e
and no `shots`.

It took three runs. Run 1: 20s hook timeouts in `notes/service.test.ts` at load
average 76, with four other projects' sweeps running. Run 2: fast "not found"
failures, meaning rows vanished mid-test. Nothing else was connected once it was
killed, so the likeliest cause (**unconfirmed**) is a worker orphaned by
killing run 1. Run 3 on a quiet machine: green.

Carried: **run long sweeps as tracked background tasks and re-run on a 137
before investigating anything**, and bare `dotenv` is Python — use
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
   *after* the redirect has created the log file. Killing `dotenv` orphans the
   vitest workers (re-parented to 1): kill the `node (vitest N)` children by
   cwd too. And a wait loop on `pgrep -f vitest` matches its own command line.
5. ~~§5c's ten uncaptured screens.~~ Landed 2026-09-15. `WRITEUP.md` §41.
6. ~~`executeDeparture`'s `ponytail:` 30s transaction budget.~~ Landed
   2026-09-15.
7. ~~Queued links use the stub's `http://localhost:3700`.~~ Landed 2026-09-16.
   `WRITEUP.md` §43.
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. **Three of the seed's stories are dated from the real clock** — the capstone
   leave, Rosa's, and Anders'. Cause **unknown**: one `shots` run produced a
   `calendar-front-desk.png` differing from `HEAD` in exactly one cell (a
   *confirmation state*), and the re-run reproduced `HEAD` byte-for-byte. Worth
   one look if it recurs.
10. ~~A departing coverer's alert blocks their departure.~~ Landed 2026-09-16:
    the block stays, it is now asked about the last day. `WRITEUP.md` §44.
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
