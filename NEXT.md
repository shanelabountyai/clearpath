# Next

**First, the step that needs a person** (carried, and now blocking one more
thing than it was).

1. **`CRON_SECRET` is still unset on Vercel.** All *three* cron routes answer
   401 until it is set — `nonresponse` joined the list this session:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour
   and `/api/cron/nonresponse` after the half hour.

**Item: loose thread 5 — §5c, ten of sixteen screens have no capture.** The
remaining picture thread, and the one the README's access argument does not
already cover. Decide whether a screen inventory is a document this project
wants at all, and if so which screens earn a capture. Judgement about what to
show, not correctness-critical, so **Sonnet** is enough:

    /model sonnet

## What just landed (loose thread 3)

- **The two commands answered opposite ways, and the reason is the fee.**
  `nonresponse:run` was an omission — its own header described a schedule it did
  not have. It now has `nonResponseRun` in `src/jobs.ts`, a route beside the
  other two, and `30 * * * *` (offset from the horizon at :00; nothing depends
  on the order, they just have no reason to contend).
- **Its own runner, not a second sweep on `remindersRun`.** That runner touches
  no money and this is the only automatic path to a charge, so they need
  separate stop switches.
- **`delivery:run` deliberately has no cron, and that is now written down** on
  the script itself, where somebody reaching for the entry is standing. Half of
  it is schedulable; the receipt half marks every message `delivered` with no
  carrier having said so, and the no-show fee rests on that state. Scheduling it
  is a job that fabricates the evidence for a charge.
- **`scripts/nonresponse-run.ts` now calls the shared runner**, not
  `runNonResponseSweep` directly. It was the one script bypassing `jobs.ts`,
  which is how the two doors drift.
- **One new unit test, and it is on neither runner.** `jobs.test.ts` → "has a
  route for every schedule and a schedule for every route". Verified red with
  the vercel.json entry removed: it named the missing path.
- **What it still does not do:** no monitoring, no dead-letter, and no bound on
  the sweep. The first scheduled run on the deployment walks the whole `pending`
  backlog and could exceed a function timeout — survivable because each
  appointment commits in its own transaction, so it drains itself over a few
  half-hours. Recorded in `WRITEUP.md` §40.
- **Two `ponytail:` remain in `src/`** — `public-inquiry.ts` and `inbound.ts`.

## Gate

Green. Typecheck clean. **3208 unit passed across 32 files** (+1: the new
wiring test), `EXIT=0`. Production build clean, `/api/cron/nonresponse`
registered dynamic.

**No e2e sweep this time, deliberately.** Nothing renders differently, no spec
touches a cron route, and the only e2e-detectable risk in the diff was whether
the new route builds — so `build:e2e` was run on its own instead of the 63-spec
sweep. If you want the full gate before the next deploy, that is the outstanding
piece.

The exit-137 note from last session got one more data point: a **foreground**
`npm test` was also killed at 137, with no jetsam file for its minute, 74%
memory available and pressure 0. Re-running it as a tracked background task
succeeded unchanged. So the cause is not memory and not the `&` subshell
specifically — **run long sweeps as tracked background tasks and re-run on a
137 before investigating anything.**

## Loose threads

1. ~~`listProgressNotes`' audit row names the first leave a cover holds.~~
   Landed 2026-09-15. What remains is narrower and deliberate: a leave that
   contributed no notes still gets its row.
2. ~~P1-4 lists nothing for a returning supervisor, and has no dismissal.~~
   Landed 2026-09-14.
3. ~~`delivery:run` and `nonresponse:run` have no scheduler.~~ Landed
   2026-09-15. Argued both ways: `nonresponse` wired at `30 * * * *`, `delivery`
   deliberately never — one reads evidence, the other invents it.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`, and a totals grep must anchor on
   `^ *N passed` because the seed's summary contains "failed". Arm the monitor
   *after* the redirect has created the log file — `tail -f` on a path that
   does not exist yet dies instantly and the sweep then runs unwatched.
5. Design brief **§5c: ten of sixteen screens have no capture** — `/worklists`
   now has one section of one. **This is the next item.** The README's pictures
   argue the access rule; a screen inventory is a different document, and
   whether this project wants one has never been decided.
6. ~~`executeDeparture`'s `ponytail:` 30s transaction budget.~~ Landed
   2026-09-15. Measured: the caseload was never the risk, the per-process-note
   audit row was.
7. Queued links use the stub's `http://localhost:3700`, now on two hourly crons.
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. **Three of the seed's stories are dated from the real clock** — the capstone
   leave, Rosa's, and Anders'. Which seeded day the calendar picture lands on is
   fixed, but whether a real-clock leave overlaps it is not, so that picture can
   gain or lose its away banner between runs.
10. An alert the leaver holds only as a *coverer* on somebody else's leave still
    blocks their departure rather than moving (D-31 risk line). The fix is on
    that leave — name another cover, or end it.
11. D-26's routing (a departed clinician's alert reaching their supervisor's
    cover) still has no seeded picture: the seed's one departure is planned,
    not executed, and executing it would spend the departure demo.
12. Seven clinicians in the seed now, so a new leave still collides with a spec
    that names one of them. The fix each time is a locator that finds the row
    by its link, not by a name it mentions.
13. ~~No seeded picture of a returning supervisor.~~ Landed 2026-09-15.
14. The dismissal has no undo. One row per leave, and restoring the section
    means recording the leave again.
15. The gallery coverage test knows a component's name appears in
    `app/design/page.tsx`, not that the specimen shows anything useful.
    Looking at the picture is still part of the work.
16. §5b's **loading and error states have nothing to photograph**: there is no
    `loading.tsx` or `error.tsx` anywhere in `app/`. Giving them a specimen
    means designing them first, which is a feature, not a picture.
17. §5b's screener result card, co-sign ageing row, audit row and form fields
    are inline page markup, not primitives, so the gallery cannot import them.
    They have screen-level pictures instead.
18. **"While you were away" is four lists rendered as one flat list**, ordered by
    kind rather than by date, so the countersignature row can sit below a later
    session. Grouping headings would be a design change, not a caption.
19. **No cron run is monitored.** A 500 from any of the three is a line in
    Vercel's log and nothing else. Idempotence makes it survivable rather than
    handled, and the non-response sweep's unbounded backlog rides on that.
