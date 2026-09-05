# Next

**Item:** Appointment confirmation loop — **Phase 4, the money** —
[prd-appointment-confirmation.md](prd-appointment-confirmation.md), P0-5, P0-6,
P0-7 and P0-9. Waiver ships in the same phase as the automatic charge; neither
is shippable without the other.

Phase 3 is committed and pushed (`34175c6`). What exists now:

- `confirmAppointment` / `declineAppointment` in `src/portal/service.ts`, on the
  existing `PortalLink`. They share one `ownAppointment` guard with
  `requestReschedule` — another client's appointment is `NotFound`, never
  `Forbidden`; cancelled is `already_cancelled`; past is `in_the_past`, which is
  also what makes a `no_response` row unreachable from the door.
- Decline calls `cancelAppointment` with the client as actor and
  `confirmation: 'declined'` riding in the same write. `setStatus` gained
  `opts.confirmation` for exactly that, so the answer and the cancellation are
  one transaction with one audit row. **No new money logic on decline** —
  `classifyCancellation` and `lateCancelFeeCents` are untouched.
- The `client` role has one matrix cell: `appointment: { update: 'token' }`,
  where `token` requires `Target.ownerClientId === actor.id`. `setStatus` sets
  that target on every appointment write; staff rules decide on `always` and
  ignore it.
- `ensurePortalLink(clientId, clock, db?)` — the cadence's link, reused not
  re-minted. `newPortalToken` re-rolls until `indiscreetTerms` is empty.
- `appointment_reminder` in `src/messaging/outbox.ts` now carries the link. Its
  exact rendered body is asserted in both `outbox.test.ts` and
  `reminders.test.ts`.
- `app/p/[token]/` — two buttons where `confirmation === 'pending'`, the
  interstitial behind `?fee=<appointmentId>`, `sayYes` / `sayNo` actions.
- `e2e/portal.spec.ts` + `e2e/portal-fixture.ts` (4 specs, green).

**Read before starting Phase 4 — a real finding from Phase 3.** The pg adapter
stores a JS `Date` as its **UTC wall clock labelled in the session's timezone**.
Write and read cancel out, so the app is self-consistent and every unit spec
passes. But any column the *database* clock fills is not written through that
lens: `Appointment.createdAt` defaults to `CURRENT_TIMESTAMP`, so on a machine
west of Greenwich it reads back earlier than it truly is — by 5 hours on this
laptop. `dueStages` treats `createdAt` as the notice a booking had, so the skew
**widens** stage eligibility rather than narrowing it, which is the wrong
direction for the rule a fee rests on. Invisible on a UTC box (CI, Vercel).
Decide in Phase 4 whether `createdAt` should be written from the injected clock
at booking time — it touches `bookAppointment`, `materialiseSeries`,
`bookGroupSession` and the seed, so it is its own commit, not a drive-by.
Recorded in the `WRITEUP.md` decisions log.

Phase 4 specs to build:

- **P0-5** the sweep at `startAt + graceMinutes`: sets `no_response` **always**;
  transitions `status` to `no_show` **only** from `scheduled`; does nothing at
  `not_required`; system actor (`SYSTEM_ACTOR` already exists in
  `src/scheduling/reminders.ts`); `autoNoShowOnNoResponse` gates only the status
  transition and the fee. Q6's answer was two functions sharing nothing, so this
  is a new module, not a second entry point in `reminders.ts`.
- **P0-6** `setStatus(..., 'no_show')` reads `noShowFeeCents`, not
  `lateCancelFeeCents`. The field already exists at 9000, so the regression spec
  pinning existing fixtures should pass before the change and after it.
- **P0-7** waiver: new action on the existing `fee` resource in
  `permissions.ts`, admin only, front desk denied and the denial logged.
- **P0-9** plus the two structural lints the PRD asks for: no `status: 'no_show'`
  write outside `lifecycle.ts`, and no fee path that has not called
  `confirmationRequired`.
- The seed's awkward rows (≥3 clients on `none` with absences, ≥5
  completed-but-silent, ≥1 partial group decline, ≥1 waived fee) and the README
  Scope Honesty line land here too.

Gate at this commit: unit **1307/1307**, typecheck clean, `e2e/portal.spec.ts`
**4/4** against the production build. The rest of the e2e suite was not re-run —
no staff-side UI changed, but the portal page did, so a full sweep before Phase 4
lands would be cheap insurance.

Still open from earlier, answered but not actioned: the "refer a friend" growth
motion is off (anti-kickback / state patient-brokering / ethics codes, and a
referral program cannot be built without linking two clients' records). The
defensible version is a fixed-list `referralSource` field at intake —
attribution only, no credit, no link between client records.
