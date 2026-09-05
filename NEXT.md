# Next

**Item:** Appointment confirmation loop — **Phase 5, the rest of P1** —
[prd-appointment-confirmation.md](prd-appointment-confirmation.md), P1-2, P1-3,
P1-4 and P1-5. P1-1 already shipped in Phase 4, so the order the PRD gives is
now: cadence cap, then inbound keyword handling, then the report.

Phase 4 is committed and pushed. **The feature is P0-complete.** What exists:

- `src/scheduling/nonresponse.ts` — `sweepAt` (pure, the whole policy as one
  function of two fields and one flag) and `runNonResponseSweep(clock)`. Writes
  `no_response` always, transitions `status` to `no_show` only from `scheduled`,
  re-checks `confirmationRequired` **and** the existence of an outbox row before
  the money, and goes through `setStatus` so the fee, the status and the
  determination are one transaction with one audit row. `npm run sweep:run`.
- `setStatus(..., 'no_show')` reads `noShowFeeCents` (schema default 9000,
  identical to `lateCancelFeeCents`, so the split changed nothing).
- `waiveFee(actor, id, reason, { clock })` in `lifecycle.ts` behind a new
  `fee: waive` matrix cell, admin only. **The matrix is now 546 cells**, not 455
  — three docs quote that number and all three are updated.
- `confirmationTrail(actor, appointmentId)` and `noResponseFees(actor)` in
  `src/reports/audit.ts`, both gated on `audit_log` (auditor only).
- Reason codes on every state change in the feature. `setStatus` derives its
  code from `opts.confirmation`; the operational cancel reason deliberately does
  not reach the audit row.
- `unconfirmedSoon(actor, { clock, withinHours })` in `worklists.ts`, plus the
  front-desk section on `/worklists` (P1-1, pulled forward).
- `ConfirmationChip` beside `StatusChip` on the appointment page; a dashed
  border and an ellipsis on the calendar chip; the no-show fee and the four
  confirmation settings on `/practice`.
- Two lints: no fee path that has not called `confirmationRequired`, and no id
  in a job's log line. The shared write-vs-filter helper is `src/test/lint.ts`.
- `prisma/metrics.ts` — fifteen success metrics, run by the seed itself and by
  `npm run verify:seed`. **The seed throws if any fails.**
- `e2e/money.spec.ts` — the waiver's one role, and the work list's phone number.

Gate at this commit: unit **1544/1544**, typecheck clean, e2e **26/26** against
a production build, seed green on all fifteen metrics (34 charges from 692
eligible sessions, 4.91%).

**The Phase 3 timezone finding is fixed, not carried.** `bookAppointment` and
`bookGroupSession` now stamp `createdAt` from the injected clock, and a lint in
`booking.test.ts` requires every appointment insert to name it. Nothing is
outstanding from it.

Phase 5 specs to build:

- **P1-2, and it probably should have been P0.** ~70 standing clients × 3
  messages × 52 weeks is ~11,000 messages a year, and the failure mode is not
  cost — it is that the reminder stops being read, which degrades the very
  signal the fee depends on. Proposal in the PRD: after
  `confirmationStreakCap` consecutive confirmations (default 4), drop that
  client's series to `d1` only until they miss one. Needs a schema field and a
  branch in `dueStages`, which is pure, so it is a unit spec first.
- **P1-3** inbound keyword handling, committed rather than conditional (Q1).
  Classify a body as `confirm | decline | unparsed` and **store only the
  classification** — D-04, and the reason is that a client can reply to an
  inbound channel with a crisis disclosure. An `unparsed` reply raises an
  `Alert` to the treating clinician only (hard rule 9), sends the neutral
  "please call us" auto-reply carrying the practice number and the crisis line,
  and surfaces to front desk as "this client replied — call them," with nothing
  to read.
- **P1-4** confirmation-rate report beside the existing utilization report:
  confirmed / declined / no-response / not-required per clinician and
  practice-wide, plus the fee total the policy generated. `noResponseFees` is
  already the query underneath the fee half.
- **P1-5** decline reason codes — reuse the portal's existing four rather than
  inventing a parallel vocabulary.

**The standing recommendation, unchanged and not withdrawn.** Risk 1 in the PRD:
non-response in counseling correlates with the reason people are attending, so
this policy's fee falls hardest on the clients least able to answer, and the
practice learns about it as attrition rather than as complaints. The loop and
the work list are the defensible half and both now ship. The number to look at
before defending the money is the seeded quarter's non-response rate, and
`autoNoShowOnNoResponse = false` is one row if it reads badly.

Still open from earlier, answered but not actioned: the "refer a friend" growth
motion is off (anti-kickback / state patient-brokering / ethics codes, and a
referral program cannot be built without linking two clients' records). The
defensible version is a fixed-list `referralSource` field at intake —
attribution only, no credit, no link between client records.

**Local setup note.** `playwright.config.ts` expects Playwright's own browser
download. On a machine that ships a system Chromium instead, run the sweep with
`launchOptions: { executablePath: ... }` added to `use` — it was not committed,
because pinning a path in the repo would break the ordinary install.
