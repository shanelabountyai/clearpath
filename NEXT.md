# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: loose thread 3 — `delivery:run` and `nonresponse:run` have no
scheduler.** The reminders and purge crons exist; these two are deliberately
manual and the thread has never been argued either way in writing. Decide and
either wire them or record why not. Wiring-shaped, not correctness-critical, so
**Sonnet** is enough:

    /model sonnet

## What just landed (thread 6)

- **`executeDeparture`'s 30s budget now has a measurement under it**, and the
  measurement moved the problem. The `ponytail:` blamed the caseload; the
  caseload is bounded (active clients only, ~1.8ms each, forty in 109ms). The
  unbounded term was P0-10's — one audit row per process note the leaver ever
  wrote, tenure-shaped rather than caseload-shaped, ~4,000 after four years.
- **`auditEvents` in `src/auth/guard.ts`** writes them in one `createMany`,
  sharing the `row()` builder `record` already used. Counting Prisma's SQL:
  4,000 rows go from 4,000 statements to 2 (it chunks at the 65,535-parameter
  ceiling). Local wall clock is only 2.06s → 0.83s — a localhost round trip is
  ~0.1ms, so the rest is row building and four indexes. The saving is latency:
  ~20s of it at 5ms a trip against a hosted database.
- **One new unit test**, `departure.test.ts` → "still writes a row per draft and
  per process note when there are several". Verified red against a batch
  degraded to its first row: it reported one client where the fix reports three.
- **What it still does not do:** the bounded loops (caseload, supervisees,
  unread alerts) still write a row at a time, on purpose — and `leave-plan.ts`'s
  `rerouteAlerts` has the identical shape and bound, so it is untouched.
  Recorded in `WRITEUP.md` §39's "deliberately does not do".
- **Two `ponytail:` remain in `src/`** — `public-inquiry.ts` and `inbound.ts`.

## Gate

Green. Typecheck clean. **3207 unit passed across 32 files** (+1: the new test).
**e2e 62 passed / 1 skipped / 63 of 63**, `EXIT=0`. No `npm run shots` — the
change is an audit row, nothing renders differently. Committed and pushed.

Two runs were killed at exit 137 before the green one, and neither was this
code. The first was jetsam, confirmed by `JetsamEvent-2026-09-15-133726.ips`,
while three Claude sessions swept at once (clinic, Restaurant ordering, rental
business) and load hit 133. The second had no jetsam file for its minute and no
competing sweep — a detached `( ... ) &` subshell reaped when its Bash call
returned. **Start a long run as a tracked background task, not a `&` subshell.**

## Loose threads

1. ~~`listProgressNotes`' audit row names the first leave a cover holds.~~
   Landed 2026-09-15. What remains is narrower and deliberate: a leave that
   contributed no notes still gets its row.
2. ~~P1-4 lists nothing for a returning supervisor, and has no dismissal.~~
   Landed 2026-09-14.
3. **`delivery:run` and `nonresponse:run` have no scheduler, on purpose. This
   is the next item** — argue it in writing either way.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`, and a totals grep must anchor on
   `^ *N passed` because the seed's summary contains "failed". Arm the monitor
   *after* the redirect has created the log file — `tail -f` on a path that
   does not exist yet dies instantly and the sweep then runs unwatched.
5. ~~Design brief §5b components with no picture.~~ Landed 2026-09-15. **§5c
   remains: ten of sixteen screens have no capture** — `/worklists` now has one
   section of one. Deliberate for now; the README's pictures argue the access
   rule and a screen inventory is a different document.
6. ~~`executeDeparture`'s `ponytail:` 30s transaction budget.~~ Landed
   2026-09-15. Measured: the caseload was never the risk, the per-process-note
   audit row was. What remains is deliberate — nothing caps how much work one
   departure may do, only what the unbounded part costs.
7. Queued links use the stub's `http://localhost:3700`, now on the hourly cron too.
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. **Three of the seed's stories are dated from the real clock** — the capstone
   leave, Rosa's, and now Anders'. Which seeded day the calendar picture lands
   on is fixed, but whether a real-clock leave overlaps it is not, so that
   picture can gain or lose its away banner between runs. The wording fix above
   makes it correct either way; it does not make it stable.
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
    `app/design/page.tsx`, not that the specimen shows anything useful. A
    specimen rendered with props that hide what the component does passes.
    Looking at the picture is still part of the work — that is how both the
    footnote bug and the calendar banner were found.
16. §5b's **loading and error states have nothing to photograph**: there is no
    `loading.tsx` or `error.tsx` anywhere in `app/`. Giving them a specimen
    means designing them first, which is a feature, not a picture.
17. §5b's screener result card, co-sign ageing row, audit row and form fields
    are inline page markup, not primitives, so the gallery cannot import them.
    Deliberate — extracting them would be work for the style guide against the
    code. They have screen-level pictures instead.
18. **"While you were away" is four lists rendered as one flat list**, ordered by
    kind rather than by date, so the countersignature row can sit below a later
    session. Only the badge says which kind a row is. Grouping headings would be
    a design change, not a caption.
