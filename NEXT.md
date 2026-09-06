# Next

**Item:** nothing outstanding. Phase 13 built password recovery — the largest
named gap after authentication itself — and the four directions the last handoff
listed are now three. The next one is still a choice rather than a queue.

Phase 13 is committed and pushed. What landed on top of Phase 12:

**The question was never "how does somebody get back in".** It was **what does a
link prove**. It proves control of a mailbox: one factor, and the weakest one in
the building. Phase 12 bought the property that a clinical account is never
reachable with one factor, and a reset flow is the door that undoes that quietly
if nobody looks — because a reset feels like plumbing and nobody re-reads it.

**Three answers, decided as a pure function across seven roles:**

```ts
export function resetStage(user: { role: Role; enrolled: boolean }): ResetStage {
  if (!requiresSecondFactor(user.role)) return 'set_password';
  if (user.enrolled) return 'second_factor';
  return 'refused';
}
```

`requiresSecondFactor` is the same policy function the sign-in reads, asked at a
second moment — not a second copy free to drift.

The third cell is the one worth the table. A clinical account that **never
enrolled** has no factor to demand, so a link would be a complete takeover on
mailbox access alone — and worse than the sign-in equivalent, because whoever
used it would then enrol their own authenticator and hold the factor from then
on. Those accounts get **no link at all**; the refusal is logged and the screen
says so, because otherwise somebody waits on an email that is never coming.

`resolveReset` returns no `Actor` in any variant and has no `ready` stage.
Completing a reset **signs nobody in** — it sets a password and ends every
session the account had.

**The half it is not shippable without.** Requiring the factor means somebody
who loses password *and* authenticator cannot get back in by any route the
system offers, so `clearSecondFactor` is the other half — and what the practice
manager does is *clear* a factor, never see or set one. The account drops back
to mandatory enrolment and its owner chooses the new secret. It widens the most
valuable credential in the building; the mitigation available is that every use
is one audit row naming who and naming whom, never quiet.

**Two smaller decisions from the same argument.** A valid link works **during a
lockout** and clears it — a reset link is not a password guess, and refusing it
would let anybody who knows a clinician's address close both doors by typing
wrong passwords at the first. And a code is spent once **across both doors**:
`totpLastStep` lives on the account, so a code typed at the sign-in will not then
reset the password.

Gate at this commit: unit **2035/2035**, typecheck clean, e2e **86/86** against a
production build, seed green on **all forty-eight** metrics.

**Four things worth knowing before building on this.**

1. **`RESET_MAILER` is a new environment variable, and it has to be set.** With
   it unset the reset flow refuses at the moment somebody asks for a link. The
   first draft keyed the guard on `NODE_ENV !== 'production'` instead, and the
   e2e sweep found the hole immediately — that suite runs a production build on
   purpose, so the guard fired on the one build that most needed exercising. The
   tempting fix, weakening the check, would leave a deployment one unset
   variable from a flow that appears to work while every link lands in a folder
   nobody reads.
2. **The reset mail never touches `OutboxMessage`.** That table stores `body`, so
   a link routed through it would be a live credential in a table the
   confirmation report, the work lists and the delivery job all read. A lint
   refuses any `src/messaging/` import inside `src/auth/`, so nobody simplifies
   it back later. `ResetMailer` is an interface with a filesystem driver — the
   same shape as `Carrier`, and the same amount of work left.
3. **The e2e reset specs build their own three accounts.** Completing a reset
   revokes every session the account had, and the sweep caches one token per
   person for the whole run — resetting a seeded user's password would end a
   session four spec files are still holding, and the failure would surface as a
   calendar page redirecting to the login screen with nothing connecting it
   back. One of the three is a case the seed cannot contain at all: a clinical
   account that never enrolled.
4. **Audit rows survive the accounts that made them.** The reset fixture's
   teardown tried to delete them and the database refused —
   `AuditEvent is append-only (attempted DELETE)`. `actorId` is a plain column
   with no foreign key precisely so a trail outlives the account it names.

**The method, again.** Pure function and its truth table first, then persistence,
then the screens — and the two things worth having came from the suite rather
than from reasoning: the append-only rule catching the fixture, and the
production-build guard firing on the build that most needed testing. Neither
would have been found by reading the code.

Where this could go next, in no particular order and none of it queued:

- **Account administration.** Now the largest named gap. No screen creates an
  account or sets somebody's first password; the matrix already says `admin`
  may, and the surface does not exist. The interesting part is that issuing a
  credential and resetting one are different decisions that look identical in a
  form.
- **Rate-limiting the reset request form.** An unauthenticated form that sends
  mail is a form somebody can point at a list of addresses. What it cannot do is
  *answer* — every outcome is one sentence — so today's exposure is mail volume
  rather than the staff list, which is why this is a direction rather than a
  hole. A token bucket keyed on nothing in particular would look like an answer
  without being one.
- **Record the rendered language, and the hour, on `OutboxMessage`.** Carried
  over from Phase 11 and still the best-argued of these: a client whose record
  is corrected from `en` to `es` still has delivered English reminders counting
  as having asked, and there is no language column to check it against.
- **A third language**, and **the intake forms in Spanish** — the second is not
  a copy task, because a screener's wording is clinically validated per language
  and a mistranslated item changes what the score means.

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so
this policy's fee falls hardest on the clients least able to answer, and the
practice learns about it as attrition rather than as complaints. The seeded
quarter reads **29 charged of 677 (4.28%)**, unchanged by this phase — correctly,
since signing in and getting back in touch no part of scheduling. Six phases of preconditions have
removed ways of charging the *wrong* people, and every one of those guards is
green: 0 charged without a delivered message, 0 charged when never messaged, 0
charged for a session moved too late to re-ask. **None of them touches capacity,
which is what Risk 1 is actually about**, and no number in the report answers
whether those 29 are the clients least able to answer. That remains unmeasured,
and `autoNoShowOnNoResponse = false` is still one row if the practice decides it
reads badly.

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
  draw moves the whole stream and breaks metrics unrelated to the change.
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
