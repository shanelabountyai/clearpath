# Next

**Item:** Appointment confirmation loop — **Phase 5, the P1s** —
[prd-appointment-confirmation.md](prd-appointment-confirmation.md), P1-1, P1-2,
P1-3. Order is the PRD's: work list first, cadence cap second, inbound keyword
handling third.

Phase 4 is committed and pushed (`18fe9a8`). The loop is complete end to end.
What exists now:

- `runNonResponseSweep(clock, opts)` in `src/scheduling/nonresponse.ts`, plus
  `npm run nonresponse:run`. Its own module and its own script, per Q6 — it
  shares nothing with `reminders.ts` and can be stopped without stopping the
  cadence.
- The sweep records `confirmation = 'no_response'` unconditionally and
  transitions `status` only from `scheduled`. Four independent things stop the
  charge and none of them stops the write: the status guard,
  `confirmationRequired` asked again at charge time, `autoNoShowOnNoResponse`,
  and `pending` never having been reached.
- The `no_show` write still goes through `setStatus`, so the existing lint holds
  and a sweep-set no-show derives the same fee as a human-set one. `setStatus`
  gained `opts.auditReason` (codes only — deliberately not `opts.reason`, which
  is operational free text a person typed).
- `noShowFeeCents` is read by `setStatus(..., 'no_show')`; `lateCancelFeeCents`
  keeps the cancel path. Both default 9000, so the field shipped changing
  nothing.
- `waiveFee(actor, id, reason)` in `lifecycle.ts`, behind a new `waive` action
  on `fee` in the matrix, admin only. `ACTIONS` is now six long, so the
  permission matrix is 546 cells. `guarded` gained an optional `reason` that
  falls back to the break-glass justification.
- Second structural lint in `nonresponse.test.ts`: no `no_response` write
  without `confirmationRequired` in the same module. Verified by planting one.
- Staff-side: a confirmation badge beside the status chip on the appointment
  page, `CONFIRMATION_META` in `primitives.tsx`, a waiver card gated on
  `may({action:'waive', resource:'fee'})`, and the auto-charge honesty note on
  `/practice`.
- Seed: 3 clients on `none` with absences, 6 completed-but-silent (all charged
  their own session fee, none waived), 4 chargeable no-shows, 1 waiver through
  the real path, 1 booking inside the d5 window, 1 group with a partial decline.

**The phase-3 timezone finding is closed — measured, not acted on.**
`Appointment.createdAt` reads back through Prisma with **zero** skew on this
UTC−5 laptop, whether Postgres filled it or the application wrote it, and the
notice `dueStages` computes for a booking six days out is 6.0000 days. The skew
appears only through `$queryRaw`, and the codebase's only two raw statements are
a `pg_tables` lookup and an advisory lock — neither moves a timestamp. So there
is no `bookAppointment` / `materialiseSeries` / `bookGroupSession` / seed
refactor to do. The corrected finding is in the `WRITEUP.md` decisions log.

Phase 5 specs to build:

- **P1-1 front-desk work list** — "unconfirmed and starting within N hours",
  oldest-start first, with the client's phone number visible because phoning
  them is the point. Sits beside the existing reschedule-request list in
  `src/portal/service.ts` / `app/(staff)/worklists/`. Front desk reads it under
  the existing `appointment` resource — **no new matrix row**; if one turns out
  to be needed, the 546-cell coverage assertion catches it.
- **P1-2 cadence cap** — after `confirmationStreakCap` consecutive confirmations
  (default 4), drop that client's series to `d1` only until they miss one. New
  settings column + migration. Risk 2 says this probably should have been P0:
  ~70 recurring clients × 3 × 52 is ~11,000 messages a year, and the failure
  mode is the reminder stopping being read, which degrades the signal the fee
  depends on.
- **P1-3 inbound keyword handling** — committed, not conditional (Q1). A
  simulated inbound endpoint classifying a body as `confirm | decline |
  unparsed` and storing **only the classification**, never the body (D-04). An
  `unparsed` sends the neutral "please call us" auto-reply *carrying the crisis
  line*, raises an `Alert` to the treating clinician only with reason codes
  (hard rule 9), and shows front desk "this client replied — call them" with
  nothing to read.
- **P1-4** confirmation-rate report and **P1-5** decline reason codes are the
  cheap follow-ons if the budget holds.

Gate at this commit: unit **1519/1519**, typecheck clean, e2e **22/22** against
the production build.

Still open from earlier, answered but not actioned: the "refer a friend" growth
motion is off (anti-kickback / state patient-brokering / ethics codes, and a
referral program cannot be built without linking two clients' records). The
defensible version is a fixed-list `referralSource` field at intake —
attribution only, no credit, no link between client records.
