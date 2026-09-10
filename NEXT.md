# Next

**Item:** the early-execution gap the demo found (WRITEUP §34). `executeDeparture`
moves sessions from the last day on and closes the account whenever it runs.
Clicked before the last day, it leaves every session between now and then on a
deactivated clinician. The demo left 22. This is D-06's silent half-moved state,
reached without a clash. Decision pending, asked at the end of the demo session:
refuse execution before the last day, or move sessions from the earlier of now
and the last day. Opus fits: this is transaction semantics and what the preview
scan promises (D-22).

## What just landed (capstone demo)

- **Seed:** a seventh therapist, Maren Solberg, added at the end of the seed and
  drawing nothing from the PRNG. 15 clients at 9/11/13, which no standing slot
  uses. 12 transfers (Dev Marchetti, Kai Oyelaran, Priya Vance), 2 discharges,
  1 referral to Hillside, 4 drafts, 2 unread alerts through the screener path,
  3 process notes (one closed and amended), and 1 clash planted on Kai for TC-081.
  Planned, last day 2026-09-22, every decision through `decideAssignment`.
- **`e2e/departure-demo.spec.ts`:** (1) execution refused by the clash, and psql
  shows nothing moved; (2) TC-081 re-sent to Dev, then the same plan executes,
  every count checked; (3) Dev reads the whole signed history and no private
  line appears; (4) `runProcessNotePurge` on a clock 2556 days ahead removes the
  3 notes and the amendment, and the leaver's audit trail count is unchanged.
- PRD capstone marked landed. WRITEUP §34 plus one decisions-log row.

## What the next session must know

1. The demo spec **executes and cannot be undone**. `test:e2e` reseeds. Running
   the file alone needs `npm run db:seed:e2e` first. With one worker, specs before
   it see a planned departure and specs after it see an executed one.
2. A fix that refuses early execution breaks the demo as seeded, because the
   last day (Sept 22) is after the real date. The seed's last day would have to
   move to on or before the seed's `TODAY`.
3. A child process run from a spec inherits Playwright's `FORCE_COLOR`, so a
   logged *number* comes back wrapped in ANSI codes. Print strings.

## Gate

**Green at this commit.** e2e **53 passed + 1 skipped = 54**, against the
production build. Typecheck clean. Unit suite not rerun: no `src/` change
(last run 2920/2920).

## Loose threads

1. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing, because the runner's command line has no project path. Not hit again.
2. Public form's throttle read-then-write race (`ponytail:` comment).
3. A clinician on *leave* (not departing) is still P2.
4. Design brief §5b/§5c components with no picture. Still inventory.
5. `executeDeparture`'s `ponytail:` 30s transaction budget.
6. Queued links use the stub's `http://localhost:3700`.
