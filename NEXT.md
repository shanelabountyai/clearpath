# Next

**Item:** Phase 5 is complete. Nothing is queued — pick the next thing from
[prd-appointment-confirmation.md](prd-appointment-confirmation.md)'s P2 list, or
start a new PRD.

P1-4 and P1-5 are done, committed and pushed. The confirmation loop's five P1s
are all in.

## What landed this session

**P1-4 — confirmation-rate report.** `confirmationReport(actor, range)` in
`src/reports/utilization.ts`, rendered as a full-width "Confirmations" card on
`app/(staff)/reports/page.tsx` between the clinician table and the weekly bars.

- Reads under **`attendance_history`**, the same cell as the utilisation report
  beside it. A confirmation rate alone would be defensible for front desk; a
  per-clinician silence breakdown carrying a fee total is not. The guard goes on
  the strictest thing in the payload, never on the name of the feature. Front
  desk gets `Forbidden` and the denial is asserted in the test.
- Rate is `confirmed / (confirmed + declined + no_response)`. Dividing by booked
  would let a `reminderPreference: 'none'` client drag their clinician's number
  down for choosing a safety setting.
- `feeCents` counts **only** a `no_response` that became a `no_show`. A late
  cancel is charged whether or not anyone was asked. A waiver zeroes
  `chargeFeeCents`, so a reversal drops out with no second condition — and the
  `noResponse` count deliberately does not drop with it.
- One `findMany` + JS tally, matching `utilizationReport` directly above it,
  rather than three reconciled `groupBy`s plus a name lookup.
- `declineReasons` is practice-wide only, and omits the nulls.

**P1-5 — decline reason codes.** `Appointment.declineReason RescheduleReason?`
(migration `20260907021406_decline_reason`), threaded
`sayNo` → `declineAppointment` → `cancelAppointment` → `setStatus`, beside the
existing `confirmation` option so answer and reason land in one write.

- Reuses the portal's four codes. `RESCHEDULE_REASONS` /`isRescheduleReason`
  are now exported from `src/portal/service.ts`; the type is `DeclineReason` in
  `lifecycle.ts` (lowest layer — portal aliases it, so there is one list).
- **Nullable, and null is the majority case.** The portal asks without requiring
  an answer, and P1-3's keyword decline can never carry one. A default value
  would turn every texted "no" into a preference nobody stated.
- The server action **drops** an unrecognised value rather than throwing: the
  reason annotates the decline, it does not authorize it.
- The fee interstitial carries its own select rather than threading the first
  tap's choice through the redirect — that would put a reason code in a URL.
- `ReasonSelect` in `app/p/[token]/page.tsx` serves all three asks; `blank` is
  what separates required (reschedule) from optional (decline).

Seed: 2 portal declines, 1 with a code and 1 without, plus the group-session
decliner now carrying `cannot_make_it`. Against the e2e seed the report reads
8 confirmed / 4 declined / 10 no-response, $270 of fee from silence, and two
reason codes with two declines that said nothing.

## Gate at this commit

Unit **1561/1561**, typecheck clean, e2e **24/24** against the production build.
Migrations applied to dev, test and e2e; e2e reseeded.

No new e2e spec: `denials.spec.ts` already crawls `/reports` as every seeded
role, so the card is covered against a crash and against front desk the day it
lands. The arithmetic is unit-tested.

## Still open, answered but not actioned

The "refer a friend" growth motion is off — anti-kickback, state
patient-brokering, ethics codes, and a referral program cannot be built without
linking two clients' records. The defensible version is a fixed-list
`referralSource` field at intake: attribution only, no credit, no link between
client records.
