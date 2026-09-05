# Next

**Item:** the confirmation loop's **P2-1 is done** — the fee no longer rests on a
message the practice queued, but on one a carrier says arrived. Risk 3 in
[prd-appointment-confirmation.md](prd-appointment-confirmation.md) is closed.
What remains is the rest of the P2 list, and none of it is load-bearing the way
that one was.

Phase 6 is committed and pushed. What landed on top of Phase 5:

- **A `Carrier` port and a delivery state machine, both pure**
  (`src/messaging/carrier.ts`). Four states, and the important pair is `sent`
  and `delivered`: `sent` means a carrier took the message, which is the old
  precondition wearing a better name, and nothing lets it near money. Receipts
  are ordered by the **carrier's** clock, not by arrival, because provider
  webhooks retry and duplicate — and since the fee reads that field, ordering by
  arrival would let somebody else's retry policy decide who gets charged.
- **The jobs** (`src/messaging/delivery.ts`): `dispatchOutbox` hands due
  messages over, `recordReceipt` is the webhook path and the only route to
  `delivered`, `runCarrier` is what a cron wants. `POST /api/delivery` behind
  **its own** secret — `/api/inbound` can cancel an appointment, and a
  delivery-receipt credential has no business being able to do that.
  `npm run carrier:run`.
- **The fee's precondition.** `runNonResponseSweep` asks `deliveryProven` before
  it asks anything about money. One delivered stage is enough. A session where
  nothing arrived is exempted to `not_required` — **never `no_response`**,
  because the client did not do anything; the practice failed to reach them —
  under its own audit code `confirmation_undelivered`. A grep lint refuses any
  future path to `no_response` that does not consult delivery.
- **The exemption produces a phone call.** `unreachableClients` on `/worklists`,
  with the address that failed; a client drops off it the moment anything
  reaches them, with no "handled" button to tidy. And the delivery rate sits
  beside the fee total on `/reports`, because it is now the fee's precondition.
- **The seeded quarter runs a carrier** on the same hourly tick as the cadence,
  failing a deterministic slice.

Gate at this commit: unit **1698/1698**, typecheck clean, e2e **42/42** against a
production build, seed green on **all twenty-six** metrics.

**The number this phase was for.** Requiring delivery cost the policy almost
nothing and made it defensible: **33 fees from 685 eligible sessions (4.82%),
against 34 from 692 (4.91%)** when a queued row was enough. Of 1,176 reminders,
1,153 delivered, 23 never arrived, 38 got there only on a retry. **7 sessions
were asked about and never reached, and not one was charged** — that is now a
seed metric rather than a claim.

**Three things worth knowing before building on this.**

1. **The carrier is still simulated, and that is the standing honesty gap.**
   `simulatedCarrier` is the only driver; nothing leaves the machine. The seam
   is real — a deployment writes a second `Carrier` and changes no policy code —
   but the README's Scope Honesty banner is the thing to keep accurate here, not
   this file.
2. **The sweep does not retro-charge.** A receipt arriving after a session has
   been exempted cannot turn the exemption back into a fee. The practice did not
   have its proof at the moment it decided, and re-deciding money on
   late-arriving evidence is worse than being slightly conservative. If a
   deployment's provider is slow enough for this to bite, the fix is a delivery
   grace window before the sweep, not a retro-charge.
3. **There is deliberately no flag to go back to charging on `queued`.** Every
   other policy in this feature has a settings row behind it. That row would be
   a knob for turning the honesty off.

P2, in the order that matters now:

- **Confirmation state feeding the waitlist.** A decline at `d5` is a
  five-day-notice opening, which is exactly what a waitlisted client can take.
  `waitlistMatches` already exists and takes a slot. The obvious next one: it is
  self-contained, visible on the calendar, and the only P2 item that adds value
  to a client rather than protecting one.
- **Per-client cadence selection** — a client who wants only the day-of nudge.
  The cap made the machinery: `ConfirmationSettings.capped` is already a
  per-client property threaded through a pure function. Mostly a settings-UI
  problem.
- **Multi-language message bodies.** The deny-list is English-only and would need
  one per language. A real gap, and named. Worth noting it is now *two* gaps: the
  deny-list and the inbound keyword lists in `classifyReply`.

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so this
policy's fee falls hardest on the clients least able to answer, and the practice
learns about it as attrition rather than as complaints. This phase removed one
way of being wrong — charging for the practice's own failed sends — and did not
touch that one. Everything defensible now ships. The number to look at before
defending the money is still the seeded quarter's non-response rate on
`/reports`, and `autoNoShowOnNoResponse = false` is one row if it reads badly.

**Two earlier decisions, accepted by the owner on 2026-09-05 and not reopened.**
`STOP` stays a fourth classification that sets `reminderPreference = 'none'` and
sends nothing back; the auto-reply keeps "call or text 988 at any hour" rather
than the deny-listed phrase "crisis line". Both remain one-branch reversals.

Still open from earlier, answered but not actioned: the "refer a friend" growth
motion is off (anti-kickback / state patient-brokering / ethics codes, and a
referral program cannot be built without linking two clients' records). The
defensible version is a fixed-list `referralSource` field at intake —
attribution only, no credit, no link between client records.

**Local setup notes.**

- `INBOUND_WEBHOOK_SECRET` **and** `DELIVERY_WEBHOOK_SECRET` must be set in
  `.env`, `.env.test` and `.env.e2e`, or those routes refuse every request. That
  refusal is deliberate; see the two files under `app/api/`.
- **The Playwright browser note from the last phase is now handled in config.**
  Set `PLAYWRIGHT_CHROMIUM_PATH` to a system Chromium and the sweep uses it;
  unset, the config is exactly what it was and Playwright downloads its own
  pinned build. Env-gated rather than committed as a literal path, because
  hard-coding one would break every ordinary checkout.
- Seeded client phone numbers are the full ten-digit fictional form
  (`555-555-01NN`). The seven-digit form they replaced fails
  `plausibleDestination`, which is the carrier being right rather than the check
  being wrong — but it made every sms client undeliverable, so it is worth not
  reintroducing.
