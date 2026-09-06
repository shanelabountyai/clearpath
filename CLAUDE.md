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
10. **Credentials never leave `src/auth/`.** No file outside it names
    `passwordHash`, `totpSecret`, `pendingTotpSecret`, `totpLastStep` or
    `tokenHash`, and nothing outside the sign-in flow touches the session
    cookie. `sessions.test.ts` greps `src/` and `app/` and fails the build.
    Containment rather than vigilance: a page that *can* select a credential
    column is one careless `select` from putting it in its own HTML.
11. **Only a fully authenticated session yields an `Actor`.** The
    half-authenticated stage — password accepted, second factor not — is a
    distinct variant of `Resolved` with no actor on it, so authorizing from an
    unfinished sign-in is a type error rather than a review comment.

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

## Write-up

`WRITEUP.md` is maintained as the project goes, not archaeologically at the end.
Each core learning artifact gets an entry when it lands: what the problem was,
what the design does, what it deliberately does not do.
