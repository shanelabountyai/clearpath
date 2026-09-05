# Next

**Item:** Appointment confirmation loop — **Phase 2, the cadence** —
[prd-appointment-confirmation.md](prd-appointment-confirmation.md), P0-3.

Phase 1 is committed and pushed (`5d5cf51`). What exists now:
`src/scheduling/confirmation.ts` — `confirmationRequired`, `stageDueAt`,
`dueStages`, all pure and green — plus the migration (`confirmation`,
`AppointmentReminder`, `noShowFeeCents`, `dayOfLeadHours`, `graceMinutes`,
`autoNoShowOnNoResponse`, waiver columns) and the `no_show` write lint.

Build `runReminderHorizon(clock, opts)` on top of `dueStages`: one
`AppointmentReminder` row per due stage under the `@@unique([appointmentId,
stage])` key, `queueToClient` for the outbox row, `confirmation` promoted to
`pending` **only where a stage actually queued** — that invariant is what makes
the fee defensible, and `dueStages` already returns `[]` for a booking inside
the day-of lead. Copy the idempotency shape from `materialiseSeries`.

Specs P0-3 asks for: horizon run twice = zero duplicates; booked 2 days out
gets d1+d0; booked 6 hours out gets d0 only; a `fixedClock` walk from booking
to fee in under a second asserting exactly 3 outbox rows; cancelled /
late_cancelled / declined / already-confirmed queue no further stages. Plus
`npm run reminders:run` as a script — no scheduler library.

Not done yet, deliberately: the README Scope Honesty line and WRITEUP section
10 land with the money in Phase 4, not ahead of it. Decisions-log rows for
Phase 1 are already in `WRITEUP.md`.

Gate at this commit: unit **1274/1274**, typecheck clean. e2e not re-run — no
UI touched, and every new column has a default.

Open side question from the user, answered but not actioned: a "refer a friend"
growth motion is off (anti-kickback / state patient-brokering / ethics codes,
and a referral program cannot be built without linking two clients' records).
The defensible version if they want it is a fixed-list `referralSource` field
at intake — attribution only, no credit, no link between client records.
