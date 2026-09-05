# Next

**Item:** P2-3 is done — a client can choose how many of the three confirmation
messages they get. What was not planned, and is the bigger half of this phase,
is what shipping it exposed: the fee had never checked that a client had time to
**answer**, only that there had been time to **ask**.

Phase 8 is committed and pushed. What landed on top of Phase 7:

- **`Client.reminderCadence`** — `full` / `day_before` / `day_of`, default
  `full`. `stagesFor` in `confirmation.ts` is the rule, and the rule is that a
  **stated preference beats an inferred one**: the streak cap narrows `full` and
  nothing else. `day_before` is spelled the same as the cap's own output on
  purpose — an earned cadence and a chosen one that send the same message should
  not be two vocabularies.
- **No cadence means "nothing".** That stays `reminderPreference: 'none'`, which
  is a *safety* setting and the only one that ends the fee. A second way to
  spell it would be a second route to that exemption from a control that reads
  like a taste in messages. The picker says so where the choice is made.
- **A third precondition on the fee: `answerable`.** Alongside
  `confirmationRequired` and `deliveryProven`, with its own audit code
  (`confirmation_unanswerable`), its own grep lint, and
  `PracticeSettings.answerWindowMinutes` (default 120). It is **not** an
  exemption for wanting fewer messages — a day-of client reached with the whole
  lead ahead of them is charged like anybody else.
- **A picker on the client record**, front desk or the treating clinician, and a
  "Reached too late" count on `/reports` beside the delivery rate and the money.

Gate at this commit: unit **1769/1769**, typecheck clean, e2e **57/57** against a
production build, seed green on **all thirty-nine** metrics, determinism verified
by diffing two runs.

**The number this phase was for, and the one it did not expect.** Clients on a
lighter cadence get 1.00 messages per session against 1.62 for `full`, and are
still charged for silence. But the seeded quarter refused to finish: adding the
cadence pushed the charge rate to **5.03%**, past the PRD's own over-firing line.
It was not dice. Broken down against a scripted ~20% baseline:

| cadence | median gap, delivered → start | no reply | n |
|---|---|---|---|
| `full` | 119 hours | 19.7% | 578 |
| `day_before` | 23 hours | 5.0% | 40 |
| `day_of` | **1.0 hour** | **23.6%** | 110 |

With the answering window the rate is **4.57%**, 17 sessions stood down for
arriving too late against 14 for never arriving at all.

**Four things worth knowing before building on this.**

1. **The conservatism has a price, and it is stated rather than hidden.** The
   rule cannot tell "did not answer because there was no time" from "was never
   going to answer", and it exempts both — so day-of clients now sit at 9.7%
   no-reply, *below* the full-cadence cohort. A day-of client who genuinely
   no-showed may escape a fee a full-cadence client would have paid. A human can
   still mark the no-show; what the system may not do is charge automatically on
   evidence that thin.
2. **One number in that table is a simulation artifact.** The seeded carrier
   settles receipts on the *next* hourly tick, so a day-of message queued three
   hours out is delivered at two — which is exactly the 2.0h median the quarter
   now shows, sitting right on the 120-minute threshold. A real carrier delivers
   in seconds. The mechanism is real; that exemption *rate* is the seed's clock
   granularity, and it should not be quoted as a finding.
3. **`reminderPreference` is still not editable in the UI**, and that is now a
   visible gap rather than a hidden one — the cadence picker sits directly under
   a channel the same screen can only display. The machinery already exists (the
   cadence exempts a live `pending` row when a client moves to `none`
   mid-cadence). It is a form, and it was not this item.
4. **Adding one `chance()` call per client moves the whole seed.** It broke a
   metric and an e2e spec that had nothing to do with cadence — the dice dealt
   TC-006 a co-signature note the demo block then duplicated. Expect this from
   any change to client creation, and read a shifted number as "the stream
   moved" before reading it as a regression — but check, because this time one
   of them was real.

P2, in the order that matters now:

- **Multi-language message bodies.** The last named P2 item. The deny-list is
  English-only and would need one per language, and it is still *two* gaps: the
  deny-list and the inbound keyword lists in `classifyReply`.
- **A portal control for the cadence.** Not on the P2 list, but the obvious next
  step now the field exists. It needs a think about what a tokenized link may do
  — a forwarded link should not be able to change how somebody is contacted —
  not just a form.
- **Editing `reminderPreference`**, per (3).

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so this
policy's fee falls hardest on the clients least able to answer, and the practice
learns about it as attrition rather than as complaints. This phase is the closest
anything has come to touching it — the answering window removes a way of charging
people who had no realistic chance to reply — but it addresses *time*, not
*capacity*, and Risk 1 is about capacity. The number to look at before defending
the money is still the seeded quarter's non-response rate on `/reports`, and
`autoNoShowOnNoResponse = false` is one row if it reads badly.

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
- **Postgres must be running before anything.** `service postgresql start` on a
  fresh container; the databases survive but the server does not.
- **Playwright browser:** set `PLAYWRIGHT_CHROMIUM_PATH` to a system Chromium and
  the sweep uses it; unset, Playwright downloads its own pinned build. On this
  image that is
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` — note it is the
  versioned directory, not `/opt/pw-browsers/chromium/`.
- **A schema change needs `npm run db:generate`** before `typecheck` will
  believe it, and `db:migrate:test` + `db:migrate:e2e` before either suite runs.
  `npm run db:migrate:all` does all three databases.
- Seeded client phone numbers are the full ten-digit fictional form
  (`555-555-01NN`). The seven-digit form they replaced fails
  `plausibleDestination`, which is the carrier being right rather than the check
  being wrong — but it made every sms client undeliverable, so it is worth not
  reintroducing.
