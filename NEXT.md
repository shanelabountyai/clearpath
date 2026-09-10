# Next

**Item:** not decided. Recommended: a clinician on *leave* (not departing),
still P2. It is the largest remaining product gap now that the public form's
race is closed. Opus fits if it touches who may read a caseload while the
treating clinician is away; `opusplan` if it turns out to be scheduling only.

## What just landed (throttle race)

- `claimSlot` in `src/clients/public-inquiry.ts` is one
  `INSERT … ON CONFLICT (id) DO UPDATE … WHERE`. The row lock queues a burst;
  a refusal is the `WHERE` failing and affecting no row. No migration.
- Measured first: the old read-then-write let **10 of 10** simultaneous
  requests through a limit of 3, not the "one extra" its `ponytail:` priced.
- New unit tests: a burst of ten gets exactly three through, and the window a
  claim starts reads back through Prisma as the clock's instant.
- The UTC pinning (`::timestamptz AT TIME ZONE 'UTC'`) was tried and removed:
  with it gone every test, including the instant assertion, still passed. The
  driver already sends a `Date` as the UTC instant. The assertion is the guard.
- WRITEUP §35 and one decisions-log row.

## What the next session must know

1. The first raw-SQL write in `src/` against a zone-less `timestamp(3)`
   column. The test DB session runs in `America/Chicago`. If a driver upgrade
   changes `Date` parameters, `starts the window at the instant the clock gave`
   fails first.
2. A mutation check (remove the thing, rerun) caught that the existing window
   tests could not see a timezone shift. Worth repeating on any guard you add.
3. Outside `npm run`, a bare `dotenv` is the Python CLI. Use
   `node_modules/.bin/dotenv -e .env.e2e -- node_modules/.bin/playwright test <files>`.

## Gate

**Green at this commit.** Typecheck clean. `public-inquiry.test.ts` **35/35**.
e2e `enquire.spec.ts` **7 passed = 7** against a fresh production build. The
full unit suite and the full e2e sweep were not rerun; `claimSlot`'s only caller
is `submitPublicInquiry`, covered by both files above (last full runs 2920/2920
unit, 53 + 1 skipped = 54 e2e).

## Loose threads

1. A clinician on *leave* (not departing) is still P2 (recommended above).
2. **Kill-on-alarm pattern.** `pkill -f "$PWD.*playwright test "` matches
   nothing, because the runner's command line has no project path.
3. Design brief §5b/§5c components with no picture. Still inventory.
4. `executeDeparture`'s `ponytail:` 30s transaction budget.
5. Queued links use the stub's `http://localhost:3700`.
6. `CLEARPATH_THROTTLE_SECRET` must be set on any multi-instance deployment
   (existing `ponytail:`, a setting rather than a race).
