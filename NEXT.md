# Next

**Item:** Phase 5 of the departure PRD — P1. P1-1 the departure work-list,
P1-2 the continuity marker on the client record, P1-3 the scheduling message,
P1-4 the abandoned-note count on the practice report, P1-5 the process-note
purge preview. Sonnet for P1-1/P1-4/P1-5 (reads and rendering); Opus for P1-3,
because it sends an outbound message off a clinical event and hard rule 3's
deny-list is the whole risk.

## What just landed (Phase 4)

- **`src/staff/departure.ts`:** `decideAssignment`, `setReceivingSupervisor`
  (both `departure.update`, one audit row each), `listDepartures`,
  `getDeparturePlan`, `ownDrafts`. `planDeparture` maps P2002 →
  `Conflict('already_departing')` and refuses a past last day.
- **Bug fixed from Phase 3:** execution and the blocker scan read assignments
  through the *live* caseload. A client reassigned during the notice period is
  no longer taken back on the last day. Mutation-checked.
- **Screens:** `/departures` (list + record notice), `/departures/[id]` (plan,
  decisions, blockers, execute, withdraw, the leaver's own drafts). Nav link on
  `departure.read`. Departing marker in the person picker; a strip for the
  leaver on every page. `processNoteAfterDepartureDays` on `/practice`.
- PRD D-24 … D-26; WRITEUP §32; Phase 4 marked landed.

## What Phase 5 must know

1. **The plan screen already answers most of P1-1.** Don't build a second
   readiness screen; a `/worklists` section linking to open plans is likely
   enough. Decide that first.
2. **Names on a departure ride on `departure.read` (D-24); the unread-alert
   blocker is a count only (D-25).** P1-2's marker lives on the client record,
   under `client.read` — names and a date, no reason.
3. **P1-3 fires from `executeDeparture`**, which is one 30s transaction with a
   `ponytail:` budget. Queue into `OutboxMessage` inside it; never send inside it.
4. **`e2e/departure.spec.ts` uses Tom Bergqvist** and withdraws in `afterAll`.
   The capstone demo still needs a seeded departure, and the seed is shared by
   every spec.
5. Next's route announcer is a `role="alert"`. Filter alert locators by text.

## Gate

**Green at this commit.** Unit **2914/2914** (28 files), typecheck clean. e2e
**49 passed + 1 skipped = 50**, against the production build. No lint script.
`npm run db:status` green on all three local databases.

Two e2e runs failed on the way, both for real reasons and both fixed: a
duplicate `id="userId"` pointed a label at the dev switcher, and the refusal
locator also matched Next's route announcer.

## Loose threads

1. **The kill-on-alarm pattern missed the runner.** `pkill -f "$PWD.*playwright test "`
   matched nothing — the runner's command line does not carry the project path —
   so only the server died and the rest of the sweep failed at ~100ms each.
   `pkill -f "playwright test"` works but is not scoped to this project; the
   global convention's recipe needs a scoped form that actually matches.
2. Public form's throttle read-then-write race. `ponytail:` comment.
3. A clinician on *leave* (not departing) — still P2.
4. Design brief §5b/§5c components with no picture. Still inventory.
5. Load average was 29–45 from other work all session. Check `uptime` before
   reading a stack trace.
6. `executeDeparture`'s `ponytail:` 30s transaction budget.
