# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: design brief §5b/§5c components with no picture** (loose thread 5).
Screen work, so **Sonnet**:

    /model sonnet

## What just landed (the production reseed)

- `db:migrate:prod` applied `20260914144828_leave_back_dismissed` — prod's
  schema had been one migration behind since P1-4.
- `db:seed:prod` ran clean, `EXIT=0`, well under the 25 minutes it used to
  take. 1828 audit rows, 195 messages delivered / 3 failed, 84 progress notes,
  31 process notes, 86 form submissions.
- Verified the deployed site reads it: `clinic.labintelligence.co` returns 200
  and its home page renders the reseeded clinician names.
- **Five features, not six.** Confirmations, departures, leave, the covered
  session and the supervision cover all have a picture now. P1-4's returning
  supervisor does **not** — see loose thread 13, which the reseed confirmed
  rather than closed: Rosa is seeded away 2026-09-15 to 2026-09-21.

Two alarm-pattern notes, for the next long run:

- **Do not grep the seed's log for `failed`.** Its own summary line prints
  `195 messages delivered, 3 failed` — the same trap as loose thread 4's
  `^ *N passed`. Match `Error|Invalid|Killed|EXIT=` instead.
- `refus` in that alternation false-alarms too: the seed prints `1 logged
  process-note refusal`. Harmless, but it is a wake-up that says nothing.

## Gate

Not re-run this session — no code changed, only production data. The last
green gate stands: typecheck clean, 3204 unit passed across 32 files, six
mutations red, e2e 62 passed / 1 skipped / 63 of 63.

## Loose threads

1. `listProgressNotes`' audit row names the first leave a cover holds
   (`ponytail:`).
2. ~~P1-4 lists nothing for a returning supervisor, and has no dismissal.~~
   Landed 2026-09-14.
3. `delivery:run` and `nonresponse:run` have no scheduler, on purpose.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`, and a totals grep must anchor on
   `^ *N passed` because the seed's summary contains "failed". Arm the monitor
   *after* the redirect has created the log file — `tail -f` on a path that
   does not exist yet dies instantly and the sweep then runs unwatched.
5. **Design brief §5b/§5c components with no picture. This is the next item.**
6. `executeDeparture`'s `ponytail:` 30s transaction budget.
7. Queued links use the stub's `http://localhost:3700`, now on the hourly cron too.
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. The capstone leave is dated from the real clock. So is Rosa's — which is
   what keeps thread 13 open across every reseed, not just this one.
10. An alert the leaver holds only as a *coverer* on somebody else's leave still
    blocks their departure rather than moving (D-31 risk line). The fix is on
    that leave — name another cover, or end it.
11. D-26's routing (a departed clinician's alert reaching their supervisor's
    cover) still has no seeded picture: the seed's one departure is planned,
    not executed, and executing it would spend the departure demo.
12. Only five clinicians in the seed, so every new leave collides with a spec
    that names one of them. The fix each time is a locator that finds the row
    by its link, not by a name it mentions.
13. **No seeded picture of a returning supervisor** — confirmed by this
    reseed, not fixed by it. Rosa's cover runs from the real today forward, so
    every reseed lands her mid-leave. A picture needs the seed to date her
    leave backwards from today, which would cost the supervision-cover badge
    demo unless a second supervisor carries one of the two states.
14. The dismissal has no undo. One row per leave, and restoring the section
    means recording the leave again.
