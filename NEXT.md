# Next

**Item:** nothing outstanding. Phase 15 recorded the rendered language on
`OutboxMessage` — the oldest carried-over item, open since Phase 11 — and the
next step is again a choice rather than a queue.

Phase 15 is committed and pushed. What landed on top of Phase 14:

**Every phase since P2 has added a precondition to the same fee, and every one
was found by asking what a piece of evidence actually proves.** This one asks it
of the last thing left unasked: the messages are in a language, and the system
could not say which. `OutboxMessage` carried a body, a channel, a delivery state
and four timestamps, and every reader that needed the language looked at
`Client.language` instead.

**The rule that was already there is a rule about the send, not about the
evidence.** `queueToClient` refuses to render a template with no body in the
client's language and the cadence asks the same thing before it queues, so
nothing is ever *sent* in a language the client is not down as reading. Both read
`Client.language` live, which is correct and is the only thing they could read.
It says nothing about a record corrected afterwards. A client entered as English
in June and put right in August has three delivered English reminders on the row:
they arrived, they arrived in time, nobody could read them, and every precondition
returned true because each one asked the *record* what the client can read.

**One column, written once, at render time.**

```prisma
/// The language this body was actually written in, decided at render time and
/// never re-derived.
language Language?
```

Nullable, and the migration backfills nothing. Stamping historical rows with the
client's current language would manufacture exactly the agreement the column
exists to test for — a corrected client's English reminders relabelled Spanish,
erasing the one case it is for. `null` reads as unproven, the same posture
`deliveryProven` takes towards a message no carrier ever spoke about.

**The exemption is the visible half; the filter is the half that took the
thinking.** Every other precondition now runs on the legible messages alone:

```ts
const legible = asked.filter((r) => readable([r.outboxMessage?.language], appt.client.language));
```

A client corrected mid-cadence has two delivered English reminders and one
Spanish one that failed. Asking only "was there *a* readable message" passes —
there was one — and `deliveryProven` would then look at all three, find two
deliveries, and charge them on messages they cannot read. Narrowing the evidence
set makes the right answer (`confirmation_undelivered`) fall out instead of
needing a rule of its own.

**The seeded quarter had a metric for this and it could not fail.** It read
`canRender(templateKey, client.language)` — whether a body *exists* in that
language — and both shipped languages have every body, so the answer was yes for
every row regardless of what any of them said. It is now
`canRender(templateKey, m.language)`, a claim about what was written, and three
metrics replace what it was pretending to be.

Gate at this commit: unit **2100/2100**, typecheck clean, e2e **98/98** against a
production build, seed green on **all fifty-one** metrics. The charge rate falls
from 4.28% to **4.00%** — 27 fees of 675 eligible, down from 29 of 677. Two fees,
which is the right size: rare, and indefensible every time.

**The handoff asked for the rendered hour too, and it should not exist.**
`expiresAt` already holds it, documented on the schema as "the start of the hour
it is about", and the hour is in the body as text besides. A third copy of a fact
the row holds twice is what this codebase argues against everywhere else. The
language is different in kind: it cannot be recovered from the row at all, and
its only pointer was a field that mutates. That item is closed, not deferred.

**Four things worth knowing before building on this.**

1. **A correction is retroactive and the sweep is not.** `runNonResponseSweep`
   reads only `pending`, so a correction arriving after the sweep leaves the old
   fee standing on evidence that is no longer good — and that is the *realistic*
   case, because corrections often happen because somebody was charged. It is
   named in the write-up rather than closed, and it is why the seed fixture picks
   clients with exactly one silent session in the quarter: seeded the other way,
   the quarter would contain a charge its own metric correctly calls unsupported.
   This is the best-argued next item on the list below.
2. **A session the client attended is not affected, and the first draft of the
   e2e assertion said it was.** Those rows carry the ordinary session fee, which
   rests on their having come rather than on anything they read. Scoping the
   query to `no_response` alone found five of them; the fee this policy produces
   is the `no_show` one, which is the distinction `metrics.ts` already drew.
3. **`auth.spec.ts` "the same code will not open a second session" now sets its
   own 90-second budget.** `freshCode` blocks until the step the sign-in before
   it just spent has rolled over — up to a full thirty-second TOTP period, which
   is the entire default per-test budget — and then two more sign-in flows have
   to fit in what is left. It failed one of four gate runs on nothing but where
   the wall clock happened to be. Waiting is the rule the spec is testing, so the
   budget is what gives. Unrelated to this phase; found by running the gate.
4. **The seed's per-appointment fixtures check the time window before the row
   state.** `toMove` does; `toCorrect` did not on the first draft, and every
   entry was silently dropped on the first tick of the quarter, because a session
   is `not_required` until the cadence reaches it and promotes it. The fixture
   produced nothing and the only symptom was two metrics reading zero.

Where this could go next, in no particular order and none of it queued:

- **What a correction owes the fees it invalidates.** Item 1 above. The narrow
  version is a work-list entry — "this client's language changed; three sessions
  were charged on messages in the old one" — which tells a person and decides
  nothing. The wide version is an automatic stand-down, which is money reversed
  on a row somebody may already have discussed with the client, and is a decision
  about how a practice handles its own mistakes rather than a rule a nightly job
  applies. The narrow version is the defensible one and it is still not free: it
  needs a query that is honest about *when* the correction happened, which today
  is only recoverable from the audit log.
- **Rate-limiting the reset request form.** An unauthenticated form that sends
  mail is a form somebody can point at a list of addresses. What it cannot do is
  *answer* — every outcome is one sentence — so today's exposure is mail volume
  rather than the staff list, which is why this is a direction rather than a
  hole.
- **A third language**, and **the intake forms in Spanish** — the second is not
  a copy task, because a screener's wording is clinically validated per language
  and a mistranslated item changes what the score means.

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so
this policy's fee falls hardest on the clients least able to answer, and the
practice learns about it as attrition rather than as complaints. The seeded
quarter now reads **27 charged of 675 (4.00%)**. Seven phases of preconditions
have removed ways of charging the *wrong* people, and every one of those guards is
green: 0 charged without a delivered message, 0 charged when never messaged, 0
charged for a session moved too late to re-ask, 0 charged on a message they could
not read. **None of them touches capacity, which is what Risk 1 is actually
about**, and no number in the report answers whether those 27 are the clients
least able to answer. That remains unmeasured, and `autoNoShowOnNoResponse =
false` is still one row if the practice decides it reads badly.

**Two earlier decisions, accepted by the owner on 2026-09-05 and not reopened.**
`STOP` stays a fourth classification that sets `reminderPreference = 'none'` and
sends nothing back; the auto-reply keeps "call or text 988 at any hour" rather
than the deny-listed phrase "crisis line".

Still open from earlier, answered but not actioned: the "refer a friend" growth
motion is off (anti-kickback / state patient-brokering / ethics codes, and a
referral program cannot be built without linking two clients' records). The
defensible version is a fixed-list `referralSource` field at intake —
attribution only, no credit, no link between client records.

**Local setup notes.**

- **Nobody is seeded enrolled in a second factor.** The first sign-in for a
  clinical role walks through mandatory enrolment, which is the part of the
  design worth seeing. Front desk and the auditor are in with the password
  alone — start a demo there if there is no authenticator app to hand.
- **`actAs` in the e2e suite signs people in through the real screens** and
  caches one token per person, which is a requirement rather than a shortcut: a
  code may be spent once. A spec that needs to *end* a session must use
  `signInFresh` — signing out of the shared one revokes the token every later
  spec is still holding, and the failure lands three files away with nothing
  connecting it back. A sign-in that waits for an unspent TOTP step is the suite
  obeying the rule it asked for, not padding.
- **Sign in with `stillwater-demo-passphrase`** — every seeded staff account has
  it, and `npm run db:seed` prints the addresses. It is a constant in
  `src/auth/demo.ts`, which would be indefensible anywhere else and is the only
  honest option for a public demo over invented data.
- `INBOUND_WEBHOOK_SECRET` **and** `DELIVERY_WEBHOOK_SECRET` must be set in
  `.env`, `.env.test` and `.env.e2e`, or those routes refuse every request. That
  refusal is deliberate; see the two files under `app/api/`.
- **`RESET_MAILER=dev`** in the same three files. It names the `ResetMailer`
  driver; unset, asking for a password-reset link throws rather than writing one
  to a directory nobody reads. Links land in `.dev-mail/`, which is gitignored —
  that is the mailbox for the demo and for the e2e suite.
- **Postgres must be running before anything.** `service postgresql start` on a
  fresh container; the databases survive but the server does not.
- **Playwright browser:** set `PLAYWRIGHT_CHROMIUM_PATH` to a system Chromium and
  the sweep uses it; unset, Playwright downloads its own pinned build. On this
  image that is `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` — note it
  is the versioned directory, not `/opt/pw-browsers/chromium/`.
- **A schema change needs `npm run db:generate`** before `typecheck` will
  believe it, and `db:migrate:test` + `db:migrate:e2e` before either suite runs.
  `npm run db:migrate:all` does all three databases.
- **`npm run shots` runs a horizon tick and a carrier tick first.** The seed's
  cadence stops at its frozen `TODAY` while wall time moves on, so without the
  catch-up every "awaiting reply" surface photographs empty. If a capture comes
  back looking dead, that is the first thing to check.
- **The seed does not roll for per-client attributes.** Language and anything
  else derived from the client number rather than `chance()`, because one extra
  draw moves the whole stream and breaks metrics unrelated to the change. The
  same rule governs the fixtures: `toMove` and `toCorrect` both select
  deterministically from `everything`, never from the dice.
- **`Button` lives in `src/ui/button.tsx`, not `primitives.tsx`.** Primitives
  imports `CHARGEABLE` from `scheduling/lifecycle`, which reaches the database,
  so it is server-only — importing the button from a client component dragged
  `pg` into the browser bundle and failed the production build. Primitives
  re-exports it, so every existing import site is unchanged.
- Seeded client phone numbers are the full ten-digit fictional form
  (`555-555-01NN`). The seven-digit form they replaced fails
  `plausibleDestination`, which is the carrier being right rather than the check
  being wrong — but it made every sms client undeliverable, so it is worth not
  reintroducing.
