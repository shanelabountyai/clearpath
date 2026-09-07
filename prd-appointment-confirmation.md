# PRD: Appointment Confirmation — required response, three-stage cadence, non-response fee

**Sample business:** "Stillwater Counseling" (as in the parent PRD) — 6 clinicians, 4 rooms, ~70 standing weekly clients
**Builder:** Solo, in Claude Code
**Status:** Draft v1.0 — feature PRD, child of `prd-clearpath-counseling-ops.md`. Requested by the practice owner; PM + operator review baked in (review notes tagged inline)
**Learning objectives:** a due-date job driven entirely by the injected clock, idempotent across horizon runs; separating a *communication* fact from a *clinical* fact so one cannot silently become the other; extending a tokenized no-login surface with a destructive action; a money field whose default changes no behaviour on the day it ships

---

## ⚠️ Scope Honesty (read first)

This is a **learning project with synthetic data only**. Nothing here actually sends a text message; `OutboxMessage` rows remain the stub, and if inbound SMS ships it is a simulated inbound endpoint, not a carrier integration. The feature charges nobody: `chargeFeeCents` on an appointment is a chargeable *flag* in integer cents, and there is no payment processing anywhere in Clearpath. It applies HIPAA-*inspired* design principles — no PHI in messages, URLs, logs, or the audit trail — because they are excellent engineering discipline. It is **not** HIPAA-compliant software and must never hold real client data.

One extra honesty note specific to this feature: **a real practice cannot ship an auto-charge policy without a clinical and legal review of its client agreement.** This PRD designs the mechanism and the guard rails. It does not claim the policy is defensible in any particular jurisdiction, and the seed data says so on the settings page.

## Problem Statement

Stillwater loses hours it cannot resell. A 50-minute slot that empties at 2:55 on a Tuesday is not recoverable — there is no walk-in trade in counseling — so an unattended session costs the practice the whole fee and costs a waitlisted client the whole hour. The owner's ask is a confirmation loop: a text five days out that the client must answer, nudges the day before and the day of, and a fee when nobody answers at all.

**What exists today, accurately:**

- The `appointment_reminder` template exists in `src/messaging/outbox.ts` and **nothing anywhere queues it**. There is no reminder cadence of any kind. The only client-facing messages ever queued are `appointment_confirmed` (at booking, from `app/(staff)/book/actions.ts` and `groups/actions.ts`), `form_request`, `portal_link`, and `appointment_cancelled`.
- **Nothing sends.** `OutboxMessage` rows are the stub, and there is **no inbound channel of any kind** — no webhook, no phone number, no parser, nothing that could receive a reply.
- `Appointment` has **no confirmation state**. `status` has a `confirmed` value in the enum and in `TRANSITIONS`, but it is a staff-side lifecycle step, not a client's answer, and nothing sets it from a client action.
- There is **no no-show fee field**. `PracticeSettings` carries `lateCancelFeeCents` (default 9000) and `no_show` currently reuses it in `setStatus`.
- **No status transition is automatic.** `no_show` is set by a human, today and always.

So the gap is not "wire up the reminder." Five separate things are missing: a cadence, a state to record an answer in, a surface for the client to answer on, a rule that decides what silence means, and a fee that is not the late-cancel fee wearing a hat.

The design risk is sharper than the build risk. A confirmation loop with money attached crosses three of this project's hard rules at once — it messages clients (rule 3, no PHI outside the record), it writes clinical-adjacent state (rules 4 and 8), and it can route a client's words at the front desk (rule 9). The version of this feature that is easy to build is the one that texts "Reply YES or NO" from an unknown short code to a client who chose `reminderPreference = 'none'` for their safety, gets nothing back because they never got it, and bills them 9000 cents for a session they attended.

## Goals

1. Every appointment that the practice can legitimately ask about carries a **confirmation state that is a separate fact from its attendance status** — and no code path lets silence become `no_show` for a client who arrived.
2. A three-stage cadence (5 days, 1 day, day-of) becomes due **entirely from the injected clock**, is idempotent across horizon runs, and is fully exercisable in a test that never waits.
3. A client can confirm or decline **without a login and without typing anything free-text**, on the existing tokenized portal door.
4. Non-response produces a fee **only** where the practice actually asked, the client actually could answer, and the client did not turn up.
5. Every confirmation, decline, non-response determination and fee write is audit-logged in the same transaction, with ids and reason codes only — never a message body, never a client's words.
6. **(Builder goal)** Exercise clock-driven due-date scheduling with idempotency keys, a destructive action on a no-auth token surface, and the discipline of refusing to collapse two facts into one field.

## Non-Goals

- **Actually sending SMS or email.** Outbox rows stay the stub, per the parent PRD. A carrier integration is config, not logic.
- **Payment capture.** `chargeFeeCents` is a flag. Charging the card is somebody else's product and always has been.
- **Free-text inbound.** See P0-4 and D-04: there is no box, on any surface, in either direction. The portal has no free-text field today and this feature does not give it one.
- **Rescheduling from the confirmation link.** A decline frees the hour; rebooking stays the existing `RescheduleRequest` path, which front desk handles by phone. *(operator review: a client who moves their own session every week is a pattern the practice must notice, and the portal already refuses to hide it)*
- **Per-client cadence tuning.** One practice-wide cadence in v1. Per-client stage selection is P2 and mostly a settings-UI problem.
- **A "maybe" answer.** Two options. A tri-state answer that means nothing operationally is a field somebody will later have to interpret.
- **Dunning, escalation, or a second charge.** One fee per unattended appointment, ever.

## Personas

Reused verbatim from the parent PRD; the ones this feature touches:

- **Front desk** — sees the confirmation state as an operational fact (a column and a work list: who has not answered, whose session starts in two hours). Sees no reply content, ever, because there will be none to see. Cannot waive a fee.
- **Therapist / Associate (licensed and pre-licensed)** — sees confirmation state for their own clients on the day sheet, because walking into an unconfirmed hour is their problem before it is anyone's. Receives the clinician-only alert if an unparsed inbound reply ever arrives (P1-3).
- **Supervisor** — no additional reach here. Confirmation is operational, not clinical; the two-tier note rule is untouched by this feature.
- **Practice manager (Admin)** — owns the policy: cadence toggle, `noShowFeeCents`, the auto-fee switch, and the **waiver**. The only role that can undo a fee.
- **Auditor** — read-only; must be able to reconstruct, for any charged appointment, that the ask was made, when, on what channel, and that no answer arrived.
- **Client** — never logs in. Gets a neutral message with a personal link, taps one of two buttons.

## User Stories (priority order)

1. As the **practice manager**, I want an appointment the client never answered to be visibly distinct from one they declined and from one they simply have not been asked about yet, so that the practice's no-show policy applies to silence and not to my own missing message.
2. As a **client**, I want to confirm or decline my appointment in one tap from a link, so that answering costs me nothing and I do not have to text an unknown number back.
3. As **front desk**, I want a work list of unconfirmed sessions starting within the next 24 hours, so that I phone the four people who matter instead of reading the whole calendar.
4. As the **practice manager**, I want a client who never received a confirmation request — because their preference is `none`, or they have no phone or email on file — to be **structurally exempt** from the non-response fee, so that the safety setting cannot become a billing trap. *(operator review: this is the one that would end the practice. `none` exists because for some clients a message on a phone somebody else picks up is a danger, not an inconvenience)*
5. As a **therapist**, I want a client who walks in without ever having answered to be marked attended and **not** charged, so that the fee tracks absence and not silence-plus-absence-plus-nothing-else.
6. As a **client**, I want declining five days out to cost nothing and declining the morning of to tell me plainly that it is inside the 24-hour window before I confirm the decline, so that the policy is something I am told rather than something I discover.
7. As **front desk**, I want each attendee of a group session to confirm for themselves, so that five people's answers are five facts and the group does not "confirm" because one person tapped.
8. As an **auditor**, I want to reconstruct for a charged appointment: the three sends, their timestamps and channel, the absence of any answer, the non-response determination, and the fee — without any message body appearing in the trail.
9. As the **practice manager**, I want to waive a fee in one click with a reason code, so that the correct answer to a wrongly charged client is a fix and not an apology.
10. As a **client with a standing weekly appointment**, I want not to be messaged three times a week forever, so that the reminder stays something I read.

## Requirements

Numbering is local to this feature. Existing parent-PRD requirements are referenced as `parent P0-N`.

### Must-Have (P0)

**P0-1: `confirmation` is its own field, and it is not `status`** *(core learning artifact of this feature)*
A new `AppointmentConfirmation` enum on `Appointment`: `not_required | pending | confirmed | declined | no_response`. It is written by the cadence job and the client door, and by nothing else. `status` continues to mean what it means today.
- [ ] `Appointment.confirmation` defaults to `not_required`; the cadence job is the only thing that promotes it to `pending`
- [ ] A grep-style lint (same shape as the existing role-check and author-only lints, scanning `src/` and `app/`) fails the build on any assignment that writes `status: 'no_show'` outside `src/scheduling/lifecycle.ts`
- [ ] `setStatus(actor, id, 'arrived' | 'in_session' | 'completed')` succeeds regardless of `confirmation`, and **leaves `confirmation` untouched** — a client who attends without answering ends the day as `completed` / `no_response`, and that row is the fixture the whole feature is judged on
- [ ] A unit test asserts every (`status` × `confirmation`) pair the job can produce, and that no `confirmation` value is reachable from a `status` write

**P0-2: Eligibility — the practice must have actually asked**
A pure function `confirmationRequired(client, appointment, settings): boolean`, decided before the first send and re-checked before any fee.
- [ ] `reminderPreference === 'none'` ⇒ `not_required`, permanently, at every stage and in the fee rule. Not "fewer messages": none, and therefore no fee. *(D-01)*
- [ ] A client whose chosen channel has no address on file (`sms` with `phone === null`, `email` with `email === null`) ⇒ `not_required`
- [ ] An appointment booked less than `graceMinutes` before its start ⇒ `not_required` (there was no time to ask)
- [ ] The fee rule reads `confirmation === 'no_response'`, which is unreachable without at least one `OutboxMessage` row for that appointment — asserted directly: for every appointment in the seeded quarter with a fee from this feature, at least one outbox row exists whose `appointmentId` matches
- [ ] Changing a client to `reminderPreference = 'none'` mid-cadence stops the remaining stages and moves live `pending` rows to `not_required`

**P0-3: Three-stage cadence, clock-driven and idempotent**
A new `AppointmentReminder` table: `appointmentId`, `stage` (`d5 | d1 | d0`), `dueAt`, `sentAt`, `outboxMessageId`, with `@@unique([appointmentId, stage])` — the same idempotency-key discipline as `Appointment.occurrenceKey`. One entry point, `runReminderHorizon(clock, opts)`, queues every stage whose `dueAt` has passed and which has no row yet.
- [ ] Stage due times derive from `startAt`: `d5` = start − 5 days, `d1` = start − 1 day, `d0` = start − `dayOfLeadHours` (default 3h), all computed against the injected clock. **Zero bare `new Date()`** — the existing clock lint covers this
- [ ] Running the horizon twice over the same window creates **zero** duplicate reminders and zero duplicate outbox rows (direct analogue of the existing `materialiseSeries` idempotency spec)
- [ ] An appointment booked 2 days out skips `d5` and still gets `d1` and `d0`; an appointment booked 6 hours out gets `d0` only; both are `pending`, both are fee-eligible
- [ ] A test using `fixedClock` walks a single appointment from booking to fee in under a second of wall time by advancing the clock, and asserts exactly 3 outbox rows
- [ ] Cancelled, `late_cancelled`, `declined`, and already-`confirmed` appointments queue **no further stages** — confirming at `d5` means two messages you do not get
- [ ] The horizon run is a script (`npm run reminders:run`) plus a function; no cron dependency, no scheduler library

**P0-4: The client's door — two buttons on the existing portal token** *(the design decision most likely to be argued with; see D-03 and Risks)*
Confirm and decline are new actions on the **existing `PortalLink`** surface in `src/portal/service.ts`, addressed by appointment id, gated exactly like `requestReschedule`: a token naming another client's appointment gets `NotFound`, never `Forbidden`. **No second token type is minted.** The reminder body is the existing neutral `appointment_reminder` template plus the personal link.
- [ ] The message body passes `assertDiscreet` unchanged; the template gains a link and no clinical vocabulary. A spec asserts the exact rendered string
- [ ] No free-text field is added to any client-facing page. Two buttons, plus the existing four reschedule reason codes
- [ ] Confirming is idempotent: a second tap is the same confirmation, not a second one (same rule as the open reschedule request)
- [ ] Declining **inside** the late-cancel window renders an interstitial naming the fee in dollars and requires a second tap; declining outside it does not. Both are Playwright-assertable on the seeded practice
- [ ] A decline routes through the existing `cancelAppointment`, so `classifyCancellation` — not this feature — decides `cancelled` vs `late_cancelled` and the existing `lateCancelFeeCents` applies. No new money logic on the decline path
- [ ] An expired portal link on a confirm attempt returns the existing `expired` conflict and leaves `confirmation` untouched
- [ ] Opening the link, confirming, and declining are each audit-logged with the **client as actor** and `rule: 'token'`, in the same transaction as the write, exactly like `openPortal` does today

**P0-5: What silence means, and the two things it is not**
At `startAt + graceMinutes` (default 20), a sweep evaluates appointments still `confirmation = 'pending'`.
- [ ] It sets `confirmation = 'no_response'` **always** — this is a communication fact and is recorded whatever else happens
- [ ] It transitions `status` to `no_show` **only if** `status === 'scheduled'` — never from `confirmed`, `arrived`, `in_session`, or `completed`. A front-desk check-in always beats the sweep, and a client who is mid-session is untouchable *(D-02)*
- [ ] It does nothing at all where `confirmation === 'not_required'`
- [ ] The `no_show` transition and the fee write happen in one transaction with their audit rows; the actor is a named system actor (`role: 'admin'`, id `system`), not a person, and not the client
- [ ] `PracticeSettings.autoNoShowOnNoResponse` (boolean, **default true**, per the owner's explicit ask) gates only the `status` transition and the fee. With it off, `no_response` is still recorded and the appointment lands on the front-desk work list — which is the whole feature minus the money
- [ ] A spec asserts the indefensible case directly: seeded client confirms nothing, arrives, is marked `arrived` at start − 5 min; sweep runs; `status` is untouched, `confirmation` is `no_response`, `chargeFeeCents` is null

**P0-6: The no-show fee is its own money**
New `PracticeSettings.noShowFeeCents`, integer cents, **default 9000** — identical to `lateCancelFeeCents` today, so shipping the field changes no existing behaviour. `setStatus(..., 'no_show')` stops reading `lateCancelFeeCents` and reads `noShowFeeCents`.
- [ ] Integer cents throughout; no float, no decimal string, asserted by the existing money conventions
- [ ] A regression spec pins the existing behaviour: with both fields at their defaults, every existing `no_show` fixture produces the same `chargeFeeCents` as before the change
- [ ] A spec sets `noShowFeeCents = 18000` and `lateCancelFeeCents = 9000` and asserts a no-show charges 18000 and a late cancel 9000 — the reason the fields are separate
- [ ] `attendanceSummary`'s `chargeableFeeCents` continues to sum both, unchanged
- [ ] A human-set `no_show` and a sweep-set `no_show` produce the identical fee. The policy is about the fact, not about who noticed it

**P0-7: Waiver, because an automatic charge without a reversal is not shippable**
Practice manager only. Sets `chargeFeeCents = 0` and records `feeWaivedById`, `feeWaivedAt`, `feeWaiveReason` (a code from a fixed list: `practice_error`, `client_disputed`, `emergency`, `goodwill` — not free text).
- [ ] Authorization via `src/auth/permissions.ts` only, as a new action on the existing `fee` resource. No ad-hoc role check anywhere
- [ ] Front desk attempting a waiver gets a 403 and the denial is audit-logged *(the existing lifecycle comment already says waiving a fee is a management decision, not a data-entry one — this makes it true)*
- [ ] The waiver is an audit row in the same transaction; the original fee amount is recoverable from the audit trail, not overwritten out of existence
- [ ] Waiving does not alter `status` or `confirmation`. The client still did not turn up; the practice chose not to charge

**P0-8: Group sessions confirm per attendee** *(parent P2 shipped; this must not undo it)*
- [ ] Every attendee appointment in a `groupSessionId` gets its own reminder rows, its own token-addressed confirm/decline, and its own `confirmation` value
- [ ] One attendee declining cancels **that attendee's appointment only**; the group session and every co-attendee are untouched, including the room and clinician reservation
- [ ] The non-response sweep evaluates attendees independently — 5 attendees, 2 silent, produces exactly 2 `no_response` rows
- [ ] The message body still names no group topic. `GroupSession.topic` is an operational label for the staff calendar and is on the wrong side of the deny-list to ever leave the building

**P0-9: Audit and staff-side visibility**
- [ ] Every state change in this feature — `pending`, `confirmed`, `declined`, `no_response`, the auto `no_show`, the fee, the waiver — is audit-logged in the same transaction as the write, with resource type + id and a reason code. **No message body, no phone number, no email address, no client name in the log**
- [ ] The confirmation column and the "unconfirmed, starting soon" work list are readable by front desk under the existing `appointment` resource; no new resource, no new matrix row *(if the matrix does need a row, the permission test's 100%-coverage assertion catches it — that is the point of asserting the denials)*
- [ ] The auditor can filter to appointments with a `no_response`-derived fee and see, per appointment: 3 send events, 0 answer events, 1 determination, 1 fee
- [ ] No appointment id, client id, or token appears in any app log line produced by the cadence job; counts only

### Nice-to-Have (P1)

- **P1-1: Front-desk work list** — "unconfirmed and starting within N hours," oldest-start first, with the client's phone number visible because phoning them is the point. Sits beside the existing reschedule-request list.
- **P1-2: Cadence cap for standing clients** — a weekly client currently receives 3 messages per week, indefinitely (see Risks). Proposal: after `confirmationStreakCap` consecutive confirmations (default 4), drop that client's series to `d1` only until they miss one. *(operator review asked for this before the feature shipped, not after)*
- **P1-3: Inbound reply handling — committed, not conditional** (resolved 2026-09-05: link now, keyword next) — a simulated inbound endpoint that classifies a body as `confirm | decline | unparsed` and **stores only the classification**, never the body. An `unparsed` reply: (a) sends the neutral "please call us on <number>" auto-reply, (b) raises an `Alert` to the **treating clinician only** with kind `inbound_unparsed` and reason codes only, per hard rule 9, (c) surfaces to front desk as "this client replied — call them," with nothing to read. *(D-04. The auto-reply text must also carry the crisis line, and that text is the one place a phone number for an external service is allowed.)*
- **P1-4: Confirmation-rate report** — per clinician and practice-wide, alongside the existing utilization report: confirmed / declined / no-response / not-required, and the fee total the policy generated.
- **P1-5: Decline reason codes** — reuse the portal's existing four rather than inventing a parallel vocabulary.

### Future Considerations (P2)

- Per-client cadence selection (a client who wants only the day-of nudge).
- ~~A real carrier integration behind the outbox, with delivery receipts — which would let the fee rule require *delivered*, not merely *queued*, and is the single biggest honesty upgrade available to this feature.~~ **Shipped 2026-09-07 (P2-1).** `OutboxMessage` carries `queued → sent → delivered | failed`, and the sweep charges only where at least one reminder was `delivered`. The silence is still recorded either way, and an undelivered sweep is audited as `no_response_undelivered`. What is still simulated is the carrier itself: `npm run delivery:run` hands messages over and answers for them. Attaching a real one now replaces one script, not a rule.
- Confirmation state feeding the waitlist: a decline at `d5` is a five-day-notice opening, which is exactly what a waitlisted client can take.
- Multi-language message bodies (the deny-list is English-only and would need one per language — a real gap, named).

## Success Metrics (evaluated against synthetic seeded data)

**Leading**

- **Idempotency:** the horizon run executed 10× over a 90-day seeded window produces exactly `3 × (eligible appointments)` outbox rows and zero duplicate `AppointmentReminder` rows. Hand-calculable from the seed.
- **Eligibility integrity:** across the seeded quarter, the count of appointments with a `no_response` fee whose client has `reminderPreference = 'none'` is **0**, asserted as a query, not as a code review.
- **The attended-but-silent case:** the seeded quarter contains at least 5 appointments that are `completed` + `no_response`. All 5 have `chargeFeeCents` equal to the session fee, not the no-show fee, and none has a fee waiver.
- **Clock discipline:** the full 5-day → fee lifecycle spec runs in under 1 second of wall time; the existing clock lint reports zero bare `new Date()` in the new module.
- **Audit completeness:** a scripted appointment through the whole loop produces exactly the expected audit rows (3 sends, 1 determination, 1 status write, 1 fee) and a grep of the audit table for the seeded client's name, phone and email returns 0 rows.
- **Discretion:** every rendered body across all three stages passes `indiscreetTerms(...) === []`, including the new link-bearing variant.
- **Permission coverage:** the matrix remains 100% asserted with the new `fee:waive` cells, including front desk denied and the denial logged.

**Lagging (simulated)**

- A seeded practice quarter (6 clinicians, ~70 recurring clients, ~1,100 sessions) with a scripted client-behaviour mix — 70% confirm, 10% decline, 15% silent-but-attend, 5% silent-and-absent — yields a fee total that matches a hand-tallied fixture to the cent, and yields exactly `0.05 × eligible` charged appointments. If the number charged exceeds 5% of eligible, the rule is over-firing and the spec fails.
- The front-desk work list at any seeded timestamp matches a hand-calculated set of unconfirmed sessions inside the window.
- At least 3 seeded clients have `reminderPreference = 'none'` **and** at least one absence, so the exemption is exercised by data rather than asserted in the abstract.

Measurement method: extend the existing "practice quarter" simulator with a client-response mix and a reminder-horizon tick per simulated day. Clients stay obviously fake (Test Client 001…).

## Decisions

| # | Decision | Why |
|---|---|---|
| D-01 | `reminderPreference = 'none'` means `confirmation = not_required` forever — no sends, and **structurally no fee** | The setting exists because for some clients a message on a phone somebody else may pick up is a danger. A policy that bills them for not answering a question they were never asked converts a safety setting into a financial penalty for needing it. The exemption is a branch in one pure function, not a hope that the job never reaches them. A missing phone or email lands in the same place for the same reason: the practice did not ask |
| D-02 | Confirmation and attendance are separate fields, and non-response never overrides an observed attendance | They are different facts. "Did you answer my message" and "were you in the room" are answered by different evidence, and the second is the one the fee is about. Collapsing them makes the indefensible case — charging someone who came — reachable by writing no code at all, which is the worst kind of reachable. The sweep therefore only touches rows still sitting at `scheduled`, and a check-in always wins |
| D-03 | The required response is a **tap on a tokenized link**, not a `YES`/`NO` keyword reply | "Reply YES or NO" from an unknown short code is a more conspicuous artifact on a lock screen than a neutral reminder — it demands an action, so it invites a second look from whoever is holding the phone, and it makes the sender look like a service the client is enrolled in. The deny-list keeps the *words* neutral; it cannot make a compulsory reply inconspicuous, because conspicuousness is not vocabulary. A link is one tap, works identically on email and SMS, needs no inbound channel, and puts the fee disclosure on a page where it can actually be read before it applies. **A deliberate departure from the literal request, resolved 2026-09-05: the tap-link ships first and keyword replies follow as P1-3, so a client who texts back anyway is understood rather than ignored** |
| D-04 | If keyword replies ship anyway (P1-3), an inbound body is **classified and discarded, never stored** | A client can reply with anything, including a crisis disclosure, to a number front desk monitors. Storing the body would put clinical content — possibly the most acute content this practice ever receives — on an operational surface, breaking hard rule 3, and routing it to front desk breaks hard rule 9. So the body never lands in a row: `confirm`, `decline`, or `unparsed`, and an `unparsed` raises an alert to the treating clinician with reason codes only, plus an auto-reply carrying the practice number and the crisis line. Front desk learns "call them", and nothing else. This mirrors exactly why the portal's reschedule request is a reason code with no text box |
| D-05 | The reminder link is the **existing `PortalLink`**, not a new single-purpose token | A second token type is a second expiry policy, a second revocation story, a second audit rule and a second thing to get wrong. The portal door already made this trade — holding the link is the authentication, exactly as strong as the email it arrived in — and it is already audit-logged with the client as actor. The blast radius grows honestly and is stated: a leaked or forwarded link can now see appointment times, request a reschedule, **and confirm or decline**. Declining is the new, destructive capability, and it is bounded — it cannot bypass `classifyCancellation`, cannot alter a fee, cannot touch another client's appointment (`NotFound`, so the door still discloses nothing), and every use is on the record with the client as the actor |
| D-06 | A decline **cancels**, unlike the portal's reschedule request which only asks | The portal's "it requests, it never books" rule is about *creating* commitments a person should see being made. A decline destroys one, and the practice's operational goal is a calendar that tells the truth — an hour the client has said they will not attend must free the room. The safety rail is that the decline goes through the existing `cancelAppointment`, so the 24-hour policy applies identically whoever clicked, and inside the window the client is shown the fee before the second tap. A decline that did not free the hour would make the entire feature theatre |
| D-07 | Confirmation is **per appointment instance**, never per series | The question is "are you coming Tuesday", and the standing weekly client is precisely the one who drifts — a series-level confirmation would answer for sessions the client has not thought about yet, which is the same error as confirming on their behalf. The cost is message volume for standing clients, and it is real: P1-2 exists to cap it, and it is in Risks rather than being quietly waved off |
| D-08 | Group confirmation is per attendee, and one decline cancels one attendee | Follows the parent decision that a group session is N appointments sharing a key, not one appointment with N clients. Notes, fees, attendance and audit are all about a person rather than an hour, and so is an answer. Nothing about the group model changes |
| D-09 | `noShowFeeCents` is a new field defaulting to today's `lateCancelFeeCents` value | A practice charging 50% for a late cancel and 100% for a no-show is ordinary, and one field cannot express both. Defaulting it to 9000 means the field ships changing nothing, so the migration is separable from the policy change — the two are reviewable independently, and a regression spec pins the old behaviour |
| D-10 | The auto-transition is gated by a settings flag, default **on**, and the flag governs only `status` and money | The owner asked for the charge and it is their call, so the default honours the ask rather than quietly declining it. But the flag makes "record the silence, do not act on it" a one-row change rather than a code change — which is what a practice will want the week its client agreement gets reviewed. Recording `no_response` is never optional: it is the evidence |
| D-11 | The sweep's actor is a named system actor, not the client and not a staff member | An audit row attributing an automatic charge to a person is a false statement about who decided, and this project's whole argument is that the trail is truthful. `system` is honest and greppable |

## Risks and objections

Stated rather than softened. The owner is the decision maker.

1. **The policy may be the wrong product, independent of the code.** In counseling, non-response correlates with the clinical reason for attending — a depressed client who does not answer texts is a symptom, not a defaulter — so this policy's fee falls hardest on the clients least able to answer, and the practice will learn about it as attrition rather than as complaints. That is a clinical decision, not an engineering one. Recommendation: ship the loop and the work list first, and turn the money on after a quarter of data shows what non-response actually predicts in this practice.
2. **Message volume for standing clients is high and this feature makes it worse, weekly, forever.** ~70 recurring clients × 3 messages × 52 weeks is ~11,000 messages a year, and the failure mode is not cost, it is that the reminder stops being read — which degrades the very signal the fee depends on. P1-2 is the mitigation and probably should be P0.
3. ~~**Charging on "queued" is dishonest while nothing sends.**~~ **Resolved 2026-09-07 (P2-1).** The precondition is now a delivery receipt: the sweep charges only where a reminder reached `delivered`, and an undelivered silence is recorded with no fee and its own audit reason. The remaining honesty gap is smaller and named — the receipts come from a simulated carrier rather than a real one, so what is proven today is that the *rule* reads delivery, not that any particular message arrived.
4. **The portal link becomes a destructive capability.** After this, a forwarded link cancels appointments. It is bounded and logged (D-05), and it is strictly more than the door does today. If that is unacceptable, the alternative is a single-purpose per-appointment token with a short expiry — more code, a second token story, and a smaller blast radius. Say the word and it changes.
5. **`no_show` is terminal in the state machine.** A client auto-marked `no_show` who then walks in at 3:12 cannot be un-marked; the correction is a new appointment, per the existing design. The 20-minute grace and the `scheduled`-only guard make this rare, but it is a real consequence of automating a transition into a terminal state, and it did not exist while a human set it.
6. **Three sends is a lot of surface for the deny-list.** Every new template variant is a new chance to leak vocabulary. The lint covers it at send time, which is why the lint exists — but the risk scales with the number of bodies, and this feature triples them.

## Open Questions

- **(Product) Q1 — link-tap or keyword reply? *(resolved 2026-09-05: both — link now, keyword next)*** The ask says "text message with a required response." v1 builds the response as a one-tap link (D-03), because a compulsory `YES`/`NO` to an unknown number is conspicuous on a lock screen and opens an inbound PHI channel monitored by front desk. P1-3 is no longer conditional: keyword handling follows, classified-and-discarded per D-04, so a client who replies in words is understood rather than met with silence.
- **(Product) Q2 — does the fee ship with the loop, or a quarter later? *(resolved 2026-09-05: ships with the loop, flag on)*** `autoNoShowOnNoResponse` defaults on, per the ask. Risk 1 stands as written and is not withdrawn by this answer: the seeded quarter's non-response rate is still the number to look at, and the flag is one row if it reads badly.
- **(Product) Q3 — is `noShowFeeCents` really equal to `lateCancelFeeCents`? *(resolved 2026-09-05: yes, 9000)*** The field ships defaulting to 9000, identical to `lateCancelFeeCents`, so the migration changes no behaviour and the policy change stays reviewable on its own. The field exists precisely so the practice can raise it later without a code change.
- **(Product) Q4** — do clients on `reminderPreference = 'none'` get a phone call from front desk instead, as a manual courtesy? The exemption is structural in code either way; this is an operational policy that should be written down somewhere. Recommendation: yes, and it belongs on the front-desk work list.
- **(Builder) Q5** — should the day-of stage be a fixed lead (3h) or "at 8am local"? Recommendation: fixed lead. A wall-clock rule needs practice-timezone handling for a single cosmetic gain, and `src/time.ts` already carries enough of that.
- **(Builder) Q6** — one sweep function or two (send horizon and non-response sweep)? Recommendation: two, sharing nothing. They are due at different times, have different failure modes, and only one of them touches money.
- **(Builder) Q7** — does the confirmation column belong on the existing calendar chips? Recommendation: yes, but as a border treatment, not a new colour token — the dynamic-token incident in the write-up is the reason to be careful here, and any status colour used dynamically needs the comment at its definition.

## Timeline / Phasing

- **Phase 1 — the fact.** P0-1, P0-2, and the schema migration (`confirmation`, `AppointmentReminder`, `noShowFeeCents`, waiver columns). Pure logic and structure first, per the project's TDD order: `confirmationRequired` and the stage-due-time function are both pure and both go green before anything persists.
- **Phase 2 — the cadence.** P0-3 with the clock spec and the idempotency spec. Nothing client-facing yet; the outbox rows are the proof.
- **Phase 3 — the door.** P0-4 and P0-8. The interstitial fee disclosure and the group-per-attendee specs land together.
- **Phase 4 — the money.** P0-5, P0-6, P0-7, P0-9. Waiver ships in the same phase as the automatic charge; neither is shippable without the other.
- **Phase 5 — P1.** Work list first, cadence cap second, inbound keyword handling (P1-3) third — committed per Q1, not conditional.
- **Capstone demo (60 seconds):** three seeded clients, one horizon run. One confirms and their two remaining messages never queue. One is silent and absent and is charged, with the auditor showing three sends, zero answers and one fee. One is silent and *attends* — and is not charged, because confirmation and attendance were never the same field. That third client is the whole feature.

## Build Notes for Claude Code

- **All nine hard rules in `CLAUDE.md` bind this feature**, and five of them bind it unusually tightly: authorization only via `permissions.ts` (the waiver is a matrix cell, not an `if`), no PHI anywhere but the record (three new message bodies and a new audit surface), audit in the same transaction as the action (the sweep writes status + fee + audit or it writes nothing), the injected clock (this feature is *made of* due dates — a single bare `new Date()` makes the five-day test un-runnable), and integer cents.
- **Reuse before building.** `classifyCancellation` and `cancelAppointment` already own the decline path's money. `occurrenceKey`/`materialiseSeries` is the idempotency pattern to copy. `queueToClient` already honours `reminderPreference` and already lints the body — do not reimplement any of it. `guarded` and `auditEvent` already do the same-transaction audit. `liveLink` already does token resolution and the `NotFound`-not-`Forbidden` discipline. The new code should be one module in `src/scheduling/` plus two portal actions plus one migration.
- **TDD order:** `confirmationRequired` (every eligibility cell, especially the `none` denials) → stage due-time computation → the sweep's status guard table. All three are pure. Persistence and UI after.
- **Two new structural lints**, matching the house pattern of grep-tests over `src/` and `app/` that fail on a planted violation: no `status: 'no_show'` write outside `lifecycle.ts`, and no non-`not_required` fee path that does not first call `confirmationRequired`. The existing lints exist because behavioural tests cannot say anything about the helper written next month; the same is true here, and this one has money attached.
- **The seed must include the awkward rows**, or the specs assert nothing: at least 3 clients on `none` with absences, at least 5 completed-but-silent appointments, at least 1 group session with a partial decline, at least 1 appointment booked inside the `d5` window, and at least 1 waived fee.
- **`WRITEUP.md` gets an entry when this lands** — the separation of confirmation from attendance, and the reason the required response is a tap rather than a keyword, are the two decisions worth writing down. Add the decisions table rows above to the existing log.
- **README:** the Scope Honesty banner needs one added line — nothing sends, nothing charges, and the auto-fee policy is a modeled mechanism, not clinical or legal advice.
