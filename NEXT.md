# Next

**Item:** not decided. Recommended: the public enquiry form's throttle race,
`src/clients/public-inquiry.ts:90` (`ponytail:` read-then-write, so two
simultaneous requests can both pass). It is the one loose thread that is a
correctness gap on a public door. Opus fits: a race and a database answer to it,
the way `appointment_clinician_no_overlap` answered booking.

## What just landed (D-30)

- `executeDeparture` refuses with `before_last_day` when
  `localDateOf(clock.now())` is before the last day. The check sits **inside
  `guarded`, ahead of the other blockers**, not before the transaction as first
  planned: before the guard, a supervisor's early attempt would have come back as
  a date refusal with no denial row (hard rule 4).
- Refusal order is now: NotFound → `bad_transition` → Forbidden (logged) →
  `before_last_day` → `departure_not_ready` → `hour_clash`.
- Two unit tests: an early execution on an unready plan is refused by the date,
  nothing is written, and only the supervisor's denial is logged. A run at
  00:00 on the last day moves that morning's session.
- `departure.spec.ts` now asserts the date sentence. Tom's plan is 30 days out, so
  the date answers first. No e2e covers the `departure_not_ready` sentence any
  more; the unit tests do.
- Demo seed: notice on `TODAY - 21`, last day `TODAY` (2026-09-01). Still exactly
  one clash, on TC-081 (Mon 9/07 13:00).
- WRITEUP §34 finding paragraph records D-30 as decided and built, plus one
  decisions-log row.

## What the next session must know

1. The demo spec **executes and cannot be undone**. `test:e2e` reseeds. Running
   the file alone needs `npm run db:seed:e2e` first.
2. Outside `npm run`, a bare `dotenv` is the Python CLI and `-e` fails as a
   boolean. Use `node_modules/.bin/dotenv -e .env.e2e -- node_modules/.bin/playwright test <files>`.
3. A child process run from a spec inherits Playwright's `FORCE_COLOR`. Print
   strings, not numbers.

## Gate

**Green at this commit.** Typecheck clean. `departure.test.ts` **65/65**. e2e
`departure.spec.ts` + `departure-demo.spec.ts` **8 passed = 8**, against a fresh
production build. The full e2e sweep was not rerun; no other spec reads Maren or
the departure screens (last full sweep 53 + 1 skipped = 54). The full unit suite
was not rerun either; `executeDeparture` has no callers outside
`departure.test.ts` (last run 2920/2920).

## Loose threads

1. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing, because the runner's command line has no project path.
2. Public form's throttle read-then-write race (recommended above).
3. A clinician on *leave* (not departing) is still P2.
4. Design brief §5b/§5c components with no picture. Still inventory.
5. `executeDeparture`'s `ponytail:` 30s transaction budget.
6. Queued links use the stub's `http://localhost:3700`.
