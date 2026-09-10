# Next

**Item:** the departure PRD's capstone demo — a seeded departure. It is the one
thing the PRD still owes: a therapist with 15 clients, 3 receivers, 2
discharges, 1 referred out, 4 drafts, 2 unread alerts, 1 planted hour clash
(Success Metrics → Lagging). Sonnet fits: seed data and one e2e walkthrough.
If you'd rather leave the demo, pick from the loose threads below.

## What just landed (Phase 5, P1)

- **P1-1** `departureWorklist`: a "Somebody is leaving" section on `/worklists`.
  Counts by blocker kind, the leaver's unsigned notes, days left, a link to the
  plan. No client id leaves the function (D-28). The page asks `may` first.
- **P1-2** `getClient` carries executed transfers (from, to, date). The page
  subtitle renders them. The key set is asserted.
- **P1-3** `clinician_changed` (en/es), queued inside `executeDeparture`. The
  body gives the first moved session's date and a portal link, **never the
  clinician's name** (D-27, your call). Nothing is sent for `none` (no link is
  minted either), for a client with nothing booked, or for a discharge or
  referral. Assignments now execute in `decidedAt` order.
- **P1-4** `abandonedNotesByDeparture` on `/reports`, all-time, zeros included.
- **P1-5** `previewProcessNotePurge` on `/practice`, per departure, no clients
  (D-29). It shares `processNoteWindowDays` with the sweep.
- PRD D-27 … D-29, Phase 5 marked landed. WRITEUP §33.

## What the demo must know

1. The seed is shared by every e2e spec. `departure.spec.ts` uses Tom Bergqvist
   and withdraws in `afterAll`. A seeded *executed* departure deactivates its
   leaver, so pick somebody no spec logs in as.
2. A seeded **planned** departure makes the `/worklists` section appear for
   every spec that visits that page. Filter locators by heading text.
3. Next's route announcer is `role="alert"`. Filter alert locators by text.

## Gate

**Green at this commit.** Unit **2920/2920** (28 files, 6 new), typecheck clean.
e2e **49 passed + 1 skipped = 50**, against the production build. The P1-2 and
P1-3 tests were mutation-checked: queue outside the transaction, drop the
`none` guard, mark before execution. Each one went red.

## Loose threads

1. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing, because the runner's command line has no project path. The global
   recipe needs a scoped form that matches. Not hit this session.
2. Public form's throttle read-then-write race (`ponytail:` comment).
3. A clinician on *leave* (not departing) is still P2.
4. Design brief §5b/§5c components with no picture. Still inventory.
5. `executeDeparture`'s `ponytail:` 30s transaction budget. P1-3 adds about 4
   queries per transferred client with a booked session.
6. Queued links use the stub's `http://localhost:3700`, like every other
   message. A real base URL is owed when anything actually sends.
