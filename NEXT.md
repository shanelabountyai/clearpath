# Next

**Item:** nothing outstanding. Phase 14 built account administration — the last
of the authentication gaps — and the three directions the previous handoff
listed are now two. The next one is a choice rather than a queue.

Phase 14 is committed and pushed. What landed on top of Phase 13:

**Creating an account and resetting one look identical in a form, and the
previous phase is the reason they cannot share an implementation.** `resetStage`
refuses a clinical account that never enrolled a second factor, because a link to
one is a takeover on mailbox access alone. **A brand new clinical account is
exactly that shape.** A link-only invitation would have reopened that door
through the screen a practice manager uses on somebody's first day, which is not
where anybody re-reads a security argument.

**So an invitation is two channels.** The link goes to the mailbox; an
eight-character code is shown to the administrator once, on screen, to be handed
over some other way. Neither half is sufficient. It is deliberately *not* called
a second factor — what it buys is narrow enough to state exactly: an
administrator cannot complete an invitation to a mailbox they do not control.

**The line that stops the powers composing is one function:**

```ts
export function credentialRoute(user: { hasPassword: boolean }): CredentialRoute {
  return user.hasPassword ? 'reset' : 'invite';
}
```

An invitation is issuable only to an account that has **never had a password**,
and nothing in the module sets one. An administrator who could would — combined
with `clearSecondFactor`, which they already hold — be able to sign in as any
clinician in the building, with every audit row naming the clinician. Two
individually defensible powers compose into impersonation, and the composition
is refused at the only place it could be introduced. A spec writes that
composition out rather than reasoning about it: clear a factor, then try both
doors; both stay shut.

**The review found a real ordering bug in this phase before it was committed.**
`createAccount` and `reissueInvitation` read the account *before* they
authorized, so a caller the matrix would refuse got the domain's answer — "that
account has already been set up", a fact about a colleague's account from a
screen they may not reach — and left **no denial row**, which is the half of hard
rule 4 that is easiest to lose. Confirmed with a failing spec, then fixed by
moving the validation inside the guarded callback: a `Conflict` thrown there
rolls the transaction back, allowed row included, which is the guard's own rule.
`setAccountActive` already had the ordering right, which is exactly why reading
two functions and assuming the third matches is not a review.

Gate at this commit: unit **2088/2088**, typecheck clean, e2e **96/96** against a
production build, seed green on **all forty-eight** metrics.

**Three things worth knowing before building on this.**

1. **`getByRole('alert')` is ambiguous on any page reached by a client-side
   navigation.** Next renders its route announcer as `role="alert"`, so the bare
   role resolves to two elements and Playwright's strict mode fails. Two specs
   in this phase hit it. Scope to `main`, as the reset specs already do.
2. **A page-wide `toHaveCount(0)` couples a spec to every test before it.** The
   "no seeded account offers a new invitation" assertion was written across the
   whole page, and an earlier test in the same file leaves an unclaimed account
   behind on purpose — correctly. It is asserted per row now.
3. **`newUserId()` exists because `guarded` authorizes before it works.** Every
   other model lets the database invent a cuid; account creation cannot, because
   the audit row is written from the request and an id invented halfway through
   the insert is an id that row never sees. The alternatives are an audit row
   with no `resourceId`, or authorizing after the account exists.

Where this could go next, in no particular order and none of it queued:

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
since who may sign in touches no part of scheduling. Six phases of preconditions have
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
