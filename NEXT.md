# Next

**Item:** Appointment confirmation loop — **Phase 3, the door** —
[prd-appointment-confirmation.md](prd-appointment-confirmation.md), P0-4 and
P0-8.

Phase 2 is committed and pushed. What exists now: `src/scheduling/reminders.ts`
— `runReminderHorizon(clock, opts)` and `SYSTEM_ACTOR` — plus
`scripts/reminders-run.ts` behind `npm run reminders:run`. The cadence queues
one `AppointmentReminder` per due stage under `@@unique([appointmentId,
stage])`, one transaction per appointment (messages + reminder rows +
promotion + audit row together, `P2002` read as "another run won the race"),
and promotes `confirmation` to `pending` **only** where a stage actually
queued. A client switched to `none` mid-cadence has their live `pending`
pulled back to `not_required`, so the sweep can never reach it.

Build the client's confirm/decline door on the **existing `PortalLink`**
surface in `src/portal/service.ts` — addressed by appointment id, gated
exactly like `requestReschedule`, a token naming somebody else's appointment
gets `NotFound` and never `Forbidden`. **No second token type.** Reuse
`liveLink` for resolution and `cancelAppointment` / `classifyCancellation`
for the decline path — no new money logic on decline.

Specs P0-4 asks for: the rendered reminder body asserted exactly and still
passing `assertDiscreet` once it carries a link; no free-text field anywhere
client-facing; a second confirm tap is the same confirmation, not a second
one; declining inside the late-cancel window renders an interstitial naming
the fee in dollars and needs a second tap, outside it does not (both
Playwright-assertable on the seeded practice); an expired link on confirm
returns the existing `expired` conflict and leaves `confirmation` untouched;
open / confirm / decline each audit-logged with the client as actor and
`rule: 'token'`. P0-8: every attendee of a group session gets their own
reminder rows, their own token-addressed door, and their own `confirmation`.

The reminder template does not yet carry a link — `appointment_reminder` in
`src/messaging/outbox.ts` is unchanged, and adding the link is Phase 3 work,
not a Phase 2 omission to go back and fix.

Not done yet, deliberately: the README Scope Honesty line and WRITEUP
section 10 land with the money in Phase 4. Decisions-log rows for Phases 1
and 2 are already in `WRITEUP.md`.

Gate at this commit: unit **1289/1289**, typecheck clean. e2e not re-run — no
UI touched. `npm run reminders:run` was run twice against the dev database:
6 stages queued, then 0. The seeded dev rows it promoted to `pending` reset
on the next `npm run db:seed`.

Open side question from the user, answered but not actioned: a "refer a
friend" growth motion is off (anti-kickback / state patient-brokering /
ethics codes, and a referral program cannot be built without linking two
clients' records). The defensible version if they want it is a fixed-list
`referralSource` field at intake — attribution only, no credit, no link
between client records.
