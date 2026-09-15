# Next

**First, the step that needs a person** (carried).

1. **`CRON_SECRET` is still unset on Vercel.** All three cron routes answer 401
   until it is set:

       openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET production --sensitive

   Then redeploy, and check `/api/cron/reminders` returned 200 after the hour
   and `/api/cron/nonresponse` after the half hour.

**Item: loose thread 19 — no cron run is monitored.** The last picture thread
closed this session, and what is left at the top of the list is the one that can
fail silently in production: a 500 from any of the three crons is a line in
Vercel's log and nothing else, and the non-response sweep's unbounded backlog
rides on nobody noticing. Correctness-adjacent and it touches the money path, so
**Opus**:

    /model opus

## What just landed (loose thread 5)

- **The §5c arithmetic was wrong, and that is the answer.** "Ten of sixteen
  screens have no capture" read the design brief as a checklist the repo owes.
  §5c is a brief *to a designer* — screens to wireframe and comp. Read as a
  screenshot list it asks for a gallery of the whole app, which duplicates the
  product, goes stale, and argues nothing. **No screen inventory document, and
  that is recorded as a decision rather than a gap.**
- **Two of the ten did carry a claim the README only asserted**, and they were
  the same two: the client's own surfaces. The access table has six roles and no
  row for the person the record is about, because a client has no session — they
  get a token on a phone, which is the only surface reached from outside the
  building.
- **`consent-form-client.png`** — `/f/<token>` at 390, full page. §5c-14 and
  §5c-15 in one frame: the tokenized landing and the typed-name signature are
  the same page. Names the practice and the form and nobody else.
- **`fee-disclosure-es.png`** — `/p/<ES_TOKEN>` at 390, after declining. §5c-5's
  consequence-before-confirming, on the surface where the consequence is money:
  a Spanish sentence naming `$90.00`.
- **Captured in their own browser context**, not by resizing `page`. Two
  reasons, and the second one bit first: a fresh context holds no
  `clearpath_user` cookie, so the picture is what a stranger with the link
  gets — and a stray `setViewportSize` restore silently widened the `fullPage`
  `/design` capture from 1280 to 1440. A viewport left behind is a
  cross-picture defect; both pictures below it were byte-identical on the
  re-run.
- **Reused `e2e/portal-fixture.ts` rather than writing a second one.** The fee
  screen turns on whether a decline is inside the 24-hour window, measured
  against wall time, and the seeded quarter is date-pinned — so no seeded
  appointment is reliably four hours out on the day the camera runs. One
  definition of "inside the window", not two.
- **The ES fixture clinician is now `Mireia Solans`, not `Test Clinician ES`.**
  It is the only fixture row that appears in a README picture, and nothing
  asserts on it.
- **The other eight stay unphotographed, and the reasons divide cleanly** —
  recorded in `WRITEUP.md` §41: four are features not rules; two (§5c-16's
  reminder templates, and §5b's loading/error states) would need building
  first, a feature dressed as a screenshot; two (the form-template builder, the
  admin supervision map) are functional rather than designed, and a portfolio
  picture of them would be a claim the code does not support.
- **Two `ponytail:` remain in `src/`** — `public-inquiry.ts` and `inbound.ts`.

## Gate

Typecheck clean. Unit suite run (see the log in the session scratchpad if this
handoff was written before it reported). `npm run shots` green twice, exit 0
both times.

**No full e2e sweep.** Nothing in `src/` or `app/` changed — the diff is the
shots spec, the portal fixture's clinician name, two pictures, and two
documents. `npm run shots` exercises the shots spec end to end, and the portal
spec is the one whose fixture moved, so **that spec is the outstanding check**
before the next deploy:

    dotenv -e .env.e2e -- npx playwright test portal

Still true from before: **run long sweeps as tracked background tasks and
re-run on a 137 before investigating anything.**

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
5. ~~§5c's ten uncaptured screens.~~ Landed 2026-09-15. Answered by deciding
   the question was mis-stated: no inventory document, two pictures that argue
   the client's tier. `WRITEUP.md` §41.
6. ~~`executeDeparture`'s `ponytail:` 30s transaction budget.~~ Landed
   2026-09-15.
7. Queued links use the stub's `http://localhost:3700`, now on two hourly crons.
8. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment.
9. **Three of the seed's stories are dated from the real clock** — the capstone
   leave, Rosa's, and Anders'. New data point, cause **unknown**: the first
   `shots` run this session produced a `calendar-front-desk.png` differing from
   `HEAD` in exactly one cell (13:00 telehealth: `Client 005 Fontaine · Kai`,
   unconfirmed → `Client 081 Kowalczyk · Maren`, confirmed), and the re-run
   minutes later reproduced `HEAD` byte-for-byte. Not chased — not this item,
   and asserting a cause on one non-reproducing observation is worse than
   saying unknown. Worth one look if it recurs: the cell that moved is a
   *confirmation state*, which is the one thing on that screen the reminder
   cadence writes against the real clock.
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
16. §5b's **loading and error states have nothing to photograph**: no
    `loading.tsx` or `error.tsx` anywhere in `app/`. Designing them is a
    feature, not a picture. Same class as §5c-16's reminder templates, which
    render in no route at all — both now argued in `WRITEUP.md` §41.
17. §5b's screener result card, co-sign ageing row, audit row and form fields
    are inline page markup, not primitives, so the gallery cannot import them.
18. **"While you were away" is four lists rendered as one flat list**, ordered
    by kind rather than by date.
19. **No cron run is monitored.** A 500 from any of the three is a line in
    Vercel's log and nothing else. **This is the next item.**
20. `fee-disclosure-es.png` is a 390×844 frame whose lower third is empty,
    because the screen genuinely has nothing else on it. Left uncropped
    deliberately — the emptiness is part of what the picture claims — but if it
    ever reads as a mistake, the fix is a `main`-locator capture, not a
    shorter viewport.
