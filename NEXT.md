# Next

**Item:** Phase 4 of the departure PRD — the UI. The plan screen with the
blocker list, P0-4a's unsigned-drafts list, the `processNoteAfterDepartureDays`
settings field, and the "departing, last day …" marker in the person picker
(P0-9's second notice effect). Then P1. Sonnet for the screens; Opus for the
assignment-decision action, because it writes `DepartureAssignment` under
`departure.update` and P0-11 wants one audit row per decision.

## What just landed (Phase 3)

- **The widening fix Phase 1 left behind.** `progressContext()` now resolves
  the client's `treatingClinicianId`; `listProgressNotes()` returns the whole
  record to the treating clinician. Mutation-checked: removing the join turns
  the D-04 test red.
- **Migration `20260910163704_departure_supervision_and_capacity`.**
  `Departure.receivingSupervisorId`, `Departure.acceptingNewClientsAtNotice`,
  `coSignedById` → `RESTRICT`, CHECK `departure_supervisor_is_not_the_leaver`.
- **`src/staff/departure.ts`:** `planDeparture`, `cancelDeparture`,
  `departureBlockers`, `executeDeparture`.
- WRITEUP §31; PRD D-20 … D-23; Phase 3 marked landed.

## What Phase 4 must know

1. **There is no service function that writes a `DepartureAssignment` yet.**
   Tests create them with Prisma directly. Phase 4 builds `decideAssignment`
   under `departure.update`, with an audit row per decision (P0-11's "one per
   assignment decided").
2. **`departureBlockers` returns ids, never names.** The plan screen resolves
   clients through the client resource. Admin's client read is break-glass, so
   check what the plan screen can actually render for the practice manager
   before designing it — this is the same wall D-21 hit.
3. **`planDeparture` does not map the partial-unique violation.** A second
   notice for somebody already planned surfaces as a raw Prisma P2002. Map it
   to a `Conflict` when the form exists.
4. **Hour clashes at execution are a `Conflict('hour_clash')`**, decided by the
   constraint; the other blockers are `Conflict('departure_not_ready')`. The
   screen should render both.

## Gate

**Green at this commit.** Unit **2904/2904** (28 files), typecheck clean. e2e
**45 passed + 1 skipped = 46**, against the production build. No lint script.
`npm run db:status` green on all three local databases.

The first unit run failed one test, correctly: hard rule 1's grep caught a
`role === 'supervisor'` in `departure.ts`. It now asks `may(… 'cosign' …)`.

## Loose threads

1. Public form's throttle read-then-write race. `ponytail:` comment. Still not
   worth a lock at three an hour.
2. A clinician on *leave* (not departing) — still P2.
3. Design brief §5b/§5c components with no picture. Still inventory.
4. **Another project's test sweep will make this one look broken.**
   `alongside/backend` was sweeping through all of Phase 3 at load average
   25–35. Check `uptime` and `pgrep -fl vitest` before reading a stack trace.
5. `executeDeparture` has a `ponytail:` 30s transaction budget with per-row
   audit writes; `createMany` if a real caseload ever measures near it.
