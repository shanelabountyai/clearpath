# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** Both cron routes answer 401 until
   it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour.

**Item: loose thread 13 — no seeded picture of a returning supervisor.** Seed
and date arithmetic, and it costs the supervision-cover badge demo if done
carelessly, so **Opus**:

    /model opus

## What just landed (§5b's missing specimens)

- `/design` gained the three components that existed in the vocabulary with no
  specimen: **BreakGlassDialog**, **BreakGlassBar** and the **confirmation
  badges**. Plus the **list-level denial** beside the record-level one, so the
  two read as one designed state.
- **`design-system.test.ts` now greps `app/design/page.tsx` for every export of
  `src/ui/primitives.tsx`.** Run against the previous commit it names exactly
  those three — the guard was verified to fail, not just to pass.
- `docs/screenshots/design-system.png` is the 11th picture, in the README's
  Design section. §5b now has a picture.
- **The picture found a bug.** `LockedPanel` closed with a hardcoded *"the
  official record for these sessions is under Progress notes"* — right for the
  panel it was written for, wrong for the four callers that are not about
  notes. It is now an opt-in `footnote`, defaulting on only for the default
  body. Four screens stopped telling a refused reader to go read something
  they never asked for.
- `LockedPanel` also lost its hardcoded `aria-labelledby="locked-title"` in
  favour of `aria-label` — two panels on one page was a duplicate id, and
  deriving the id from the title was worse, because one title carries a
  clinician's name.
- `WRITEUP.md` §38.

Two capture-spec notes, paid for twice this session:

- **Playwright's `getByRole` `name` is a SUBSTRING match.** `{ name:
  'Break-glass' }` also took the dialog's own "Break-glass access required" and
  died on strict mode. Pass `exact: true` whenever a specimen's heading is a
  prefix of another's.
- **Do not locate a `LockedPanel` by a fixed attribute string.** The client
  record's title is `Process notes by ${clinician.name}`. Ask for the region by
  name: `getByRole('region', { name: /^Process notes by / })`.

## Gate

Green, and it covers every code change here — the sweep ran after the footnote
fix, not before. Typecheck clean. **3205 unit passed across 32 files** (3204 +
the new coverage test). **e2e 62 passed / 1 skipped / 63 of 63**, `EXIT=0`.
`npm run shots` re-run afterwards, `EXIT=0`, all 11 pictures fresh.

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
5. ~~Design brief §5b components with no picture.~~ Landed 2026-09-15. **§5c
   remains: eleven of sixteen screens have no capture** — deliberate for now,
   the README's pictures argue the access rule and a screen inventory is a
   different document.
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
13. **No seeded picture of a returning supervisor. This is the next item.**
    Rosa's cover runs from the real today forward, so every reseed lands her
    mid-leave. A picture needs the seed to date her leave backwards from today,
    which would cost the supervision-cover badge demo unless a second
    supervisor carries one of the two states.
14. The dismissal has no undo. One row per leave, and restoring the section
    means recording the leave again.
15. The gallery coverage test knows a component's name appears in
    `app/design/page.tsx`, not that the specimen shows anything useful. A
    specimen rendered with props that hide what the component does passes.
    Looking at the picture is still part of the work — that is how the footnote
    bug was found.
16. §5b's **loading and error states have nothing to photograph**: there is no
    `loading.tsx` or `error.tsx` anywhere in `app/`. Giving them a specimen
    means designing them first, which is a feature, not a picture.
17. §5b's screener result card, co-sign ageing row, audit row and form fields
    are inline page markup, not primitives, so the gallery cannot import them.
    Deliberate — extracting them would be work for the style guide against the
    code. They have screen-level pictures instead.
