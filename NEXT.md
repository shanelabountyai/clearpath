# Next

**Item:** nothing outstanding. Phase 16 built the work list for charges a
correction leaves standing — the item Phase 15's handoff called its best-argued
next one — and the directions below are again a choice rather than a queue.

Phase 16 is committed and pushed. What landed on top of Phase 15:

**The sweep asks its preconditions once, before the money, and reads only
`pending`.** That is correct for a job and wrong for a record. `Client.language`
is a field somebody corrects, and a correction travels back into neither the
messages already delivered nor the fees those messages justified.

**And the realistic order is the awkward one.** Corrections often happen
*because* somebody was charged: the client rings about ninety dollars, and
somewhere in that conversation it comes out that the practice has had them down
in the wrong language since intake. The sweep produced the phone call and is the
one thing that will never revisit its own answer.

**Three answers, and the third is the one worth the type:**

```ts
export type FeeSupport = 'supported' | 'unreadable' | 'unrecorded';
```

Rows from before `OutboxMessage.language` existed cannot be checked either way.
Calling them unsupported turns every historical fee into an accusation nothing
can back; calling them supported is the assumption the whole line of work
refuses. They are counted and not named, and the count is on the page — a list
that omitted them silently would read as "these are all of them".

**The list decides nothing, which is the design rather than a limitation.**
`waiveFee` already exists with a named actor, a reason and one role that may use
it; the row may already have been discussed with the client; and how a practice
handles its own billing errors is a policy question rather than a rule a nightly
job applies. What was missing was never the decision — it was that nobody could
see the rows. Derived rather than stored, so correcting a record back clears the
row on its own and a waived fee leaves it.

Gate at this commit: unit **2118/2118**, typecheck clean, e2e **100/100** against a
production build, seed green on **all fifty-four** metrics.

**Four things worth knowing before building on this.**

1. **A metric inverted when the fixture landed, and the number was right.**
   Seeding two late corrections took *a translated client is charged at the same
   rate as anybody else* from 4.48% to 5.62%. A correction to Spanish is exactly
   what moves a wrongly-charged client into the Spanish cohort, so the metric had
   begun counting the practice's own discovered errors as policy outcomes — the
   more mistakes it found, the more it would report that translated clients get
   charged more. It counts supported charges only now, and reads 3.37%. The
   pattern is worth remembering: a fixture that introduces a new population can
   invert a metric measuring a different one, and the failure looks exactly like
   a regression in the thing the metric names.
2. **"No fee rests on an unreadable message" was one sentence carrying two
   facts.** The rule — the sweep never charges on what the record then called
   unreadable — still holds absolutely, and is now scoped to fees whose client's
   record has not been touched since the charge. The state it also implied is not
   true of any practice where people correct records. Three metrics replace it.
3. **The retrospective check reuses the sweep's own narrowings rather than
   inventing its own.** `dueAt >= bookedAt` from §16 and `deliveryState ===
   'delivered'` from the carrier rule. Asking a wider question afterwards than
   the fee was answered by would produce findings the charge never rested on.
4. **`npx playwright test <spec>` does not reseed the e2e database.** Only
   `npm run test:e2e` does. A new seed fixture will not be there for a
   single-spec run, and the symptom is a section that renders empty rather than
   an error — an hour is available to anybody who forgets this twice.

Where this could go next, in no particular order and none of it queued:

- **Rate-limiting the reset request form.** An unauthenticated form that sends
  mail is a form somebody can point at a list of addresses. What it cannot do is
  *answer* — every outcome is one sentence — so today's exposure is mail volume
  rather than the staff list, which is why this is a direction rather than a
  hole.
- **The same question about a corrected phone number.** A number corrected after
  a charge raises the retrospective question in a much narrower form, because
  `deliveryProven` already refuses to charge without a receipt. Named in the
  write-up as not built rather than pretended to be covered.
- **A third language**, and **the intake forms in Spanish** — the second is not
  a copy task, because a screener's wording is clinically validated per language
  and a mistranslated item changes what the score means.

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so
this policy's fee falls hardest on the clients least able to answer, and the
practice learns about it as attrition rather than as complaints. The seeded quarter reads **27 charged of 675 (4.00%)**, and four of those
charges are now visibly resting on nothing — which is the number this phase
added and the practice's to act on. Seven phases of preconditions
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
