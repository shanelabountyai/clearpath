# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: loose thread 1 — `listProgressNotes`' audit row names only the first
leave a cover holds.** A `ponytail:` in `src/notes/service.ts`, small and
correctness-shaped, so **Opus**:

    /model opus

## What just landed (thread 13)

- **`Anders Fiske` and `Thea Ozolins`**, the third and fourth scenario people,
  after Maren and Hana. Back yesterday from nine days, with all four of P1-4's
  lists populated: a flagged screener, the session Kai held, the note Kai wrote
  and signed, and one of Thea's notes Rosa countersigned as the supervision
  cover.
- **Rosa countersigns on that day's clock, not the system one.** A cover
  countersigns only inside the window (D-21), and her own leave starts today —
  the system clock would have been asking her to do it from it.
- `docs/screenshots/while-you-were-away.png` is the 12th picture, in the
  README's access-rule section rather than the demo storyboard: cover is that
  rule with an end date, and the coverer's process notes are the thing not in
  the list.
- **The picture found a bug, again.** Anders' leave covers the seed's busiest
  weekday, so the calendar's away banner walked into the README's first picture
  reading *"Away today: Anders Fiske"* on a date that is not today. It is
  scoped to the day being viewed and the heading above already names that day;
  it now reads **"Away:"**. `calendar-front-desk.png` is recaptured.
- `WRITEUP.md` §P1-4 gained the paragraph on why the picture cost two people.

## Gate

Green, and it covers every change here — the sweep and the shots both ran after
the banner fix. Typecheck clean. **3205 unit passed across 32 files**,
unchanged: the seed has no unit coverage and the calendar edit is a string.
**e2e 62 passed / 1 skipped / 63 of 63**, `EXIT=0`. `npm run shots` `EXIT=0`,
all 12 pictures fresh. Committed and pushed (`5e1cf28`).

## Loose threads

1. **`listProgressNotes`' audit row names the first leave a cover holds
   (`ponytail:`). This is the next item.**
2. ~~P1-4 lists nothing for a returning supervisor, and has no dismissal.~~
   Landed 2026-09-14.
3. `delivery:run` and `nonresponse:run` have no scheduler, on purpose.
4. Kill-on-alarm: `pkill -f "$PWD.*playwright test "` matches nothing. An e2e
   alarm must also match `Error:`, and a totals grep must anchor on
   `^ *N passed` because the seed's summary contains "failed". Arm the monitor
   *after* the redirect has created the log file — `tail -f` on a path that
   does not exist yet dies instantly and the sweep then runs unwatched.
5. ~~Design brief §5b components with no picture.~~ Landed 2026-09-15. **§5c
   remains: ten of sixteen screens have no capture** — `/worklists` now has one
   section of one. Deliberate for now; the README's pictures argue the access
   rule and a screen inventory is a different document.
6. `executeDeparture`'s `ponytail:` 30s transaction budget.
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
