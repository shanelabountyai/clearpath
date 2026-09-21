# Clearpath — working conventions

Synthetic data only. See the Scope Honesty banner in README.md; it is not
decoration, it is the first thing a reader must hit.

## Hard rules

1. **Authorization only via `src/auth/permissions.ts`.** No endpoint, loader,
   query or component performs its own role check. `permissions.test.ts` greps
   `src/` and `app/` for role comparisons outside `src/auth/` and fails the build.
2. **Process notes are author-only at every layer** — query, API, export,
   search, report, CSV. Any code path by which a non-author can reach process
   note *content* is a P0 bug, not a bug report. Repository helpers for process
   notes always take the author id and filter on it in SQL, never in JS —
   `notes/service.test.ts` greps `src/` and `app/` for a `processNote` query
   that does not name `authorId` inside the call, and fails the build.
3. **No PHI anywhere but the record itself.** Not in URLs, not in the audit log,
   not in app logs, not in error messages, not in outbound message templates.
   Ids only. The audit log records *that* a screener crossed a threshold, never
   the answers.
4. **Every clinical read and write is audit-logged in the same transaction as
   the action.** Denials are logged too. Break-glass entries are flagged.
5. **Audit rows are append-only**, enforced by a database rule, not by
   convention.
6. **Money is integer cents.** Never a float, never a decimal string.
7. **Time comes from an injected clock** (`src/clock.ts`). No bare `new Date()`
   outside it — that is what makes the 24h late-cancel window testable.
8. **State transitions go through the state machine module**, not through
   scattered `status = ...` assignments.
9. **Alerts route to the treating clinician only.** Never a shared inbox, never
   a channel, never front desk.

## Local environment

- Port **3700**, set as the default in config, not on the command line.
- Postgres is local, always — `clearpath_dev` and `clearpath_test`. Tests never
  point at a cloud database.
- `DATABASE_URL` carries `?connection_limit=10&pool_timeout=20`.
- e2e runs against a production build, not the dev server.

## TDD order

Pure logic first, because all three are the actual lessons: permission matrix
(including every denial cell) → form scoring rules → recurrence expansion.
Persistence and UI come after the logic they serve is green.

## Watching a test sweep

Verified against real runs (2026-09-16), including an induced failure and a
killed sweep — this replaced six brittle, individually-patched string
matches with one mechanism.

- **Launch under job control and kill by process group, never by pattern.**
  `npm test`'s real tree is `npm` → `dotenv` → vitest's master → one OS
  process per worker (`node (vitest N)`, no path in its argv — a `pkill -f`
  anchored to the project path never matches these). Worse, the whole tree
  is reparented to PID 1 within moments of backgrounding, so killing only
  the `dotenv`/`npm` layer leaves the master and every worker running,
  orphaned, still holding DB connections. Launch with `bash -c 'set -m; CMD
  > LOG 2>&1 & echo $!'` — job control puts every process the command forks
  into one process group whose id equals that leader's own pid, and
  reparenting to init does not change it. Kill the whole tree in one shot
  with `kill -TERM -- -<leader pid>`, at any point, orphans included. TERM
  alone can still leave a `node` straggler or two behind (confirmed live —
  two survived TERM under real load); follow with `kill -9 -- -<leader
  pid>` and check the group is empty before trusting it's dead.
- **Detect completion from the log's own terminal line, never from a
  process-existence poll.** `CMD > LOG 2>&1; echo "EXIT=$?" >> LOG` and watch
  for `^EXIT=` — a `pgrep -f vitest` wait loop can match its own invocation's
  command-line text and never see zero.
- **Arm the monitor only once the log file exists** (the shell creates it
  the moment the redirect is parsed, immediately after backgrounding — check
  once before arming rather than racing it).
- **Never grep a bare `failed`.** Two real false positives, both hit in the
  same log: `npm run test:e2e` seeds first, and the seed's own narration
  prints e.g. `197 messages delivered, 3 failed, 0 not yet due`; separately,
  a *passing* vitest test can have "failed" in its own description (`✓ ...
  charges nothing when the carrier said it failed`). Anchor instead:
  - vitest inline failure: `^\s*×` (a file with any failures also gets its
    own line, `^❯ .*\| *[0-9]+ failed\)`). Totals come only from the
    reporter's own `Test Files` / `Tests` summary lines at the end of the run.
  - Playwright inline failure: `✘` (the `list` reporter's per-test marker —
    distinct from vitest's `×`, don't reuse one sweep's pattern for the
    other). Because a webServer crash or an uncaught exception can end the
    run before any test prints a marker, the e2e alarm must also fire on a
    bare `Error:` line, not rely on `✘` alone.

## Write-up

`WRITEUP.md` is maintained as the project goes, not archaeologically at the end.
Each core learning artifact gets an entry when it lands: what the problem was,
what the design does, what it deliberately does not do.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
