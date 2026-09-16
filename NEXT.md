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

**Item: loose thread 10 — an alert the leaver holds only as a *coverer* on
someone else's leave still blocks their departure** (D-31 risk line). It's a
correctness bug in the departure blocker, so **Opus**:

    /model opus

## What just landed (loose thread 7)

- **Six places built a client URL; five said `http://localhost:3700`.** Four
  took a `baseUrl` nobody ever passed, `departure.ts` hardcoded it, and the seed
  did too. `WRITEUP.md` §43.
- **`clientUrl(path)` in `src/messaging/outbox.ts` is now the only code that
  knows a client-facing host.** The four `baseUrl` params were deleted, not
  wired up.
- **It throws rather than fall back** when production has no host. A dead link
  can't be recalled and still reports success. A throw stops the run and shows
  up in `JobRun`.
- **It also refuses on `CLEARPATH_ALLOW_CLOUD_DB`.** `db:seed:prod` runs locally
  with no `NODE_ENV`, so a `NODE_ENV` check alone would have let it write
  localhost links into production again.
- **A host pasted without `https://` gets the scheme added.** Otherwise it's a
  relative link in a text message.
- **A grep test in `outbox.test.ts`** fails the build on an absolute URL near
  `/p/` or `/f/` anywhere else. Checked against the five lines it replaced and
  against a hardcoded production domain.
- **Deliberately not per-environment:** a preview deployment links to the
  production host. Previews don't message clients.

## Gate

Typecheck clean. **Unit suite: 32 files, 3223 passed (+9), 0 skipped, exit 0.**
**e2e `intake`: 11 passed, exit 0**, against the production build. It ran after
`db:seed:e2e`, which now goes through `clientUrl`. The resolved host was checked
directly under each environment: e2e in production mode → `localhost:3700`;
the `db:seed:prod` env → `https://clinic.labintelligence.co`; cloud DB with the
variable unset → refuses.

No migration, so no `db:migrate:prod`. No full e2e sweep and no `shots`: the
seeded links are byte-identical locally, so no picture changed.

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
   *after* the redirect has created the log file.
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
