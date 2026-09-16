# Next

**All three prior person-steps landed 2026-09-16** (this session, via CLI —
Vercel auth was already active, so no manual paste was needed):

1. `CRON_SECRET` set on Vercel prod, redeployed. Still needs a person to
   check **/practice → Scheduled jobs** in the hour after a cron actually
   fires, to confirm the badges move from **Never run** to **Ran**.
2. `CLEARPATH_THROTTLE_SECRET` set on Vercel prod, redeployed. `/enquire`
   returns 200 on GET; a live POST hasn't been submitted (it would write a
   real record), so the throw-path itself is unverified in prod — worth one
   manual submission if that matters before a demo.
3. Prod re-seeded. **First attempt failed mid-run**: `resetDb()` truncated
   every table, then `P1001 DatabaseNotReachable` (Neon) killed it partway
   through building appointment series, leaving prod truncated with only
   rooms/clinicians/templates/70 bare clients — no appointments, notes,
   waitlist, or inquiries. This was a live incident, not just a script
   failure. Retried once the transient Neon blip cleared: clean `EXIT=0`,
   full quarter rebuilt (1844 audit rows, all six clinicians, the D-26/leave/
   departure stories intact). Confirm via the full log if a next session
   wants to double check: `/tmp/clinic-seed-prod-retry.log`.

   Lesson for `docs/conventions.md` / this file: `db:seed:prod` is not
   crash-safe mid-run — a dropped connection after `resetDb()` leaves prod
   truncated, not rolled back. If this happens again, the fix is the same
   retry (the script is idempotent start-to-finish), not a manual patch.

No item currently picked. Loose thread 4 landed last session; 9, 14, 15, 16,
20, 21 are deliberate non-issues already argued in `WRITEUP.md` or in this
file. No open loose threads and no open person-steps remain — next session
waits for a new item. Get a model recommendation at the start of that
session regardless.

## What just landed (loose threads 8, 11, 12, 17 — and 9, 14 reclassified)

Picked as #12; the goal then widened to all open threads in one session.

- **#12 — collision-prone e2e fixtures.** `e2e/fixtures.ts`'s `userId(name)`
  turns a display name into an id, and the seed has grown from five
  clinicians to ten without every spec catching up. Two collisions were
  already fixed by hand (`leave.spec.ts`'s row-scoped lookup, `screenshots.spec.ts`'s
  lookup by `href`); the rest either selected a `<select>` by visible label
  instead of the id already sitting in its `value`, or clicked an unscoped
  `getByRole('link', { name })` safe only by the current roster's luck.
  `leave.spec.ts` and `departure.spec.ts` now do both consistently.
  `WRITEUP.md` §46.
- **#8 — the throttle secret's silent fallback.** Unset, `CLEARPATH_THROTTLE_SECRET`
  fell back to a per-process random key — fine for a single process, wrong
  for Vercel's multi-instance default, which is what production actually is.
  Now throws in production, the same shape `clientUrl` already uses for
  `CLEARPATH_BASE_URL`. `.env.e2e` needed the var added, since `next
  build`/`next start` set `NODE_ENV=production` for the e2e sweep too.
  `WRITEUP.md` §47. **Needs the person-step above before the next deploy.**
- **#11 — D-26 had no seeded picture.** The routing rule (a departed
  clinician's alert falls to their supervisor, who may themself be covered)
  was already correct and unit-tested; nothing demonstrated it. One new
  seeded clinician (Elin, under Rosa) whose one client is discharged during
  her departure, reusing Rosa's own leave rather than seeding a second one.
  New screenshot `docs/screenshots/alert-routed-after-departure.png`, a
  README paragraph, `WRITEUP.md` §48.
- **#17 — four things were page markup, not primitives.** Extracted
  `TextField`/`SelectField` (real duplication — three pages had independently
  reinvented the same labelled input), `ScreenerResult`, `ageTone`/`CoSignRow`,
  and `AuditRow` into `src/ui/primitives.tsx`, each with a gallery specimen.
  `WRITEUP.md` §49.
- **#9 and #14 reclassified, not fixed.** Both turned out to already be
  deliberate: #9's three real-clock-dated seed stories are on purpose ("the
  point is a leave that is on while the specs run"), and #14's dismissal
  already has a WRITEUP.md rationale (§45, "no undo... the wrong shape for a
  banner") that predates this session. `NEXT.md` had just never caught up to
  either. No code or WRITEUP.md change for these two — moved to the
  deliberate-non-issue list above.

## Gate

Typecheck clean throughout. **Unit suite: 3226 passed, 0 failed, exit 0**
(full `npm test`, after the #17 primitive extraction — caught one real bug on
the first run: a gallery specimen used bare `new Date()`, which
`clock.test.ts`'s repo-wide grep correctly flagged; fixed to a fixed instant).
**e2e, twice:** first full sweep (62 passed, 1 skipped) validated #12 before
#8 and #17 landed; second full sweep, run after all four, caught a real
regression — `enquire.spec.ts` failing with `CLEARPATH_THROTTLE_SECRET is not
set`, because the e2e webServer is a production build and `.env.e2e` didn't
have it yet. Fixed, reran: 62 passed, 0 failed, exit 0. **`npm run shots`: 1
passed, exit 0** — confirmed the D-26 alert actually lands in Dev's inbox
before trusting the screenshot. Five screenshot files drifted on that run;
four were pixel noise from the real-clock-dated seed stories (#9, unrelated,
reverted — same pattern the prior session already diagnosed) and one
(`design-system.png`) was the expected, intentional result of the gallery
gaining six new sections — kept.

## This session — loose thread 4 landed

Picked as the only open loose thread; no product code touched, only
`CLAUDE.md` (new *Watching a test sweep* section) and `WRITEUP.md` (§50).

Verified against real runs rather than reasoned from the old notes alone: a
clean unit sweep (3226 passed, exit 0, 35.91s) and a deliberately-broken one
(`1 failed | 31 passed (32)`, exit 1) confirmed the reporter's actual marker
shapes and the two concrete false-positive sources (the e2e seed's own "3
failed" narration; a *passing* test whose description contains the word).
A live process inspection confirmed vitest's real tree and that killing only
`dotenv` orphans the worker (reparented to PID 1, still holding a DB
connection) — then, better than planned, a third run collided with another
project's concurrent e2e sweep on the shared local Postgres and hit a real
Prisma transaction timeout, a test timeout, and a `40P01` deadlock. The new
alarm pattern caught all three inline, and the pgid kill took the whole
group down in one shot (TERM left two `node` stragglers; `-9` finished it).
Six leaked `tail -f` monitors from prior sessions, still watching deleted
log files 3-5 days later, were found and killed along the way — not part of
the thread, just found in the process.

`WRITEUP.md` §50.

## Loose threads

1. ~~`listProgressNotes`' audit row names the first leave a cover holds.~~
   Landed 2026-09-15.
2. ~~P1-4 lists nothing for a returning supervisor.~~ Landed 2026-09-14.
3. ~~`delivery:run` and `nonresponse:run` have no scheduler.~~ Landed
   2026-09-15.
4. ~~Kill-on-alarm: six individually-patched string-match breakages.~~ Landed
   2026-09-16: one mechanism (job-control process group + log-file `EXIT=`
   line) replaces all six. `WRITEUP.md` §50, `CLAUDE.md` → *Watching a test
   sweep*.
5. ~~§5c's ten uncaptured screens.~~ Landed 2026-09-15. `WRITEUP.md` §41.
6. ~~`executeDeparture`'s `ponytail:` 30s transaction budget.~~ Landed
   2026-09-15.
7. ~~Queued links use the stub's `http://localhost:3700`.~~ Landed 2026-09-16.
   `WRITEUP.md` §43.
8. ~~`CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance
   deployment.~~ Landed 2026-09-16: unset in production now throws instead of
   silently degrading. `WRITEUP.md` §47. The person-step above is the other
   half — the code alone does not set Vercel's env var.
9. **Deliberate, not a bug.** Three of the seed's stories are dated from the
   real clock — the capstone leave, Rosa's, and Anders' — on purpose, so each
   leave is on while the specs run rather than sitting at a fixed historical
   date. Confirmed 2026-09-16. The known side effect: occasional single-cell
   screenshot drift at a day boundary, already diagnosed and not itself a bug.
10. ~~A departing coverer's alert blocks their departure.~~ Landed 2026-09-16:
    the block stays, it is now asked about the last day. `WRITEUP.md` §44.
11. ~~D-26's routing had no seeded picture.~~ Landed 2026-09-16. `WRITEUP.md`
    §48.
12. ~~Seven clinicians in the seed, so a new leave collided with a spec that
    named one by name.~~ Landed 2026-09-16: specs locate by id or by row link
    now, not by name alone. `WRITEUP.md` §46.
13. ~~No seeded picture of a returning supervisor.~~ Landed 2026-09-15.
14. **Deliberate, not a bug.** The dismissal has no undo, and `WRITEUP.md`
    §45 already argues why: a clinician holds no `leave.update` cell, so the
    write is self-scoped and deliberately off the audit log; undo would need
    widening that permission. Confirmed 2026-09-16, no change made.
15. The gallery coverage test knows a component's name appears in
    `app/design/page.tsx`, not that the specimen shows anything useful.
16. §5b's loading and error states have nothing to photograph. Argued in
    `WRITEUP.md` §41 — a feature, not a picture.
17. ~~§5b's screener result card, co-sign ageing row, audit row and form
    fields were inline page markup, not primitives.~~ Landed 2026-09-16.
    `WRITEUP.md` §49.
18. ~~"While you were away" is four lists rendered as one flat list, ordered
    by kind rather than by date.~~ Landed 2026-09-16. `WRITEUP.md` §45.
19. ~~No cron run is monitored.~~ Landed 2026-09-15. `WRITEUP.md` §42.
20. `fee-disclosure-es.png` is a 390×844 frame whose lower third is empty,
    deliberately — the emptiness is part of what the picture claims.
21. **`JobRun` has no retention sweep.** ~17.5k rows a year, so nothing is
    urgent, and it was left out on purpose: a purge that trims the table
    watching the purge can destroy the evidence that the purge stopped. If it
    ever needs one, the safe shape is a floor — keep the last N per job
    regardless of age — not a window.
