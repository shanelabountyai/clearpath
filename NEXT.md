# Next

**Item:** nothing outstanding. Phase 12 built the largest named gap —
authentication — and the four directions the last handoff listed are now three.
The next one is still a choice rather than a queue.

Phase 12 is committed and pushed. What landed on top of Phase 11:

**`requiresSecondFactor` was policy that nothing read, for five phases.** The
write-up's section 9 argued at length that this was correct: a login that always
succeeds, or a TOTP field with a fixed secret, is worse than an absent one
because it reads as present. That argument was not withdrawn — it was used as
the specification. The question was never whether there is a login screen. It is
whether the thing behind it can refuse.

**The enforcement is a type, not a check.** `resolveSession` returns a
discriminated union, and only the `ready` stage carries an `Actor`:

```ts
| { stage: 'ready'; sessionId: string; user: SessionUser; actor: Actor }
| { stage: 'second_factor'; sessionId: string; user: SessionUser }
| { stage: 'enrol_second_factor'; sessionId: string; user: SessionUser }
```

A session that cleared a password and nothing else is representable — it is a
real state a real person sits in — and there is no way to get an actor out of
it. No caller can authorize from a half-finished sign-in, and no page written
next month can either.

**The seam held.** `src/session.ts` called itself "the seam where real
authentication would go", and it was right: roughly fifty pages and server
actions take `{ actor }` off `requireSession()` and **not one of them changed a
line** when a cookie naming a user id became a session that has to be proved.

What is in it:

1. **Password** — scrypt from the standard library, salted, cost parameters
   written into every row so raising them later is a migration. Every refusal
   that is not a lockout returns one identical sentence, and an address matching
   no account still pays a full scrypt against `ABSENT_ACCOUNT_HASH`, so the
   staff list is not readable from a stopwatch.
2. **Session** — an opaque random token whose SHA-256 is what the database
   stores. 30-minute idle timeout, 12-hour ceiling. Signing out, deactivating a
   user and changing a password each end live sessions immediately rather than
   at the next timeout.
3. **TOTP** — RFC 6238, verified against the six published test vectors, driven
   by the injected clock so a spec watches a code expire instead of waiting
   thirty seconds for one. Fails four distinguishable ways: wrong, stale,
   replayed, not enrolled.
4. **Lockout** — escalating, capped at fifteen minutes, never permanent.
5. **Two structural lints** — no file outside `src/auth/` names a credential
   column, and nothing outside the sign-in flow touches the session cookie. Plus
   two smaller ones: the staff shell requires a session, and every route handler
   behind it authenticates itself, because a Next layout does not wrap a route
   handler and the two under `(staff)` export a CSV of the audit trail and a
   superbill.

Gate at this commit: unit **1999/1999**, typecheck clean, e2e **78/78** against a
production build, seed green on **all forty-eight** metrics.

**Four things worth knowing before building on this.**

1. **The dev switcher is gone, and the brief is left as written.** Item 13 of
   `DESIGN-BRIEF.md` asked for one. Keeping it beside a real login would be a
   second door whose only protection is a flag somebody has to set correctly.
   The departure is argued in WRITEUP §9 rather than edited out of the brief.
2. **`actAs` in the e2e suite signs people in through the real screens.** It is
   not a helper that mints sessions behind the login's back — that would leave
   seventy-odd specs proving the application works for people who never signed
   in. It caches one token per person, which is not a shortcut but a
   requirement: a code may be spent once.
3. **A sign-in waits for an unspent TOTP step, and that is the suite obeying the
   rule it asked for.** Playwright gives each spec file its own module registry,
   so the cache is per file, and two files signing the same person in inside one
   thirty-second window presented a code that person had already spent. The
   server refused it, correctly. If a spec ever needs to *end* a session, use
   `signInFresh` — signing out of the shared one revokes the token every later
   spec is still holding, and the failure lands three files away with nothing
   connecting it back.
4. **Nobody is seeded enrolled.** The first sign-in for a clinical role walks
   through mandatory enrolment, which is the part of the design worth seeing.
   Front desk and the auditor are in with the password alone — start a demo
   there if there is no authenticator app to hand.

**The method, again, and it is still the transferable part.** No finding is a
finding until a spec fails on it. Two specs failed here and both were worth it:
the first replay spec failed because *enrolment itself spends a step* — the
implementation was right and stricter than the spec assumed, and that became a
named spec rather than a silent line in a fixture. The second was the e2e
collision above. Neither would have been found by reasoning about the code.

Where this could go next, in no particular order and none of it queued:

- **Password recovery.** Now the largest named gap, and deliberately unbuilt
  rather than half-built. A reset link is a second credential with the same
  power as the first, delivered over email; designing it properly — expiry,
  single use, what it may reach, what it must re-prove — is its own piece of
  work, and a careless version would undo the phase that just landed.
- **Account administration.** No screen sets somebody's first password. The
  matrix already says `admin` may `create` and `update` a `user`; what is
  missing is the surface, and the interesting part is that issuing a credential
  and resetting one are different decisions that look identical in a form.
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
since authentication does not touch scheduling. Six phases of preconditions have
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

- **Sign in with `stillwater-demo-passphrase`** — every seeded staff account has
  it, and `npm run db:seed` prints the addresses. It is a constant in
  `src/auth/demo.ts`, which would be indefensible anywhere else and is the only
  honest option for a public demo over invented data.
- `INBOUND_WEBHOOK_SECRET` **and** `DELIVERY_WEBHOOK_SECRET` must be set in
  `.env`, `.env.test` and `.env.e2e`, or those routes refuse every request. That
  refusal is deliberate; see the two files under `app/api/`. Authentication
  added **no new environment variables**.
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
