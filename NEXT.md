# Next

**Item:** nothing outstanding. Every requirement in
[prd-appointment-confirmation.md](prd-appointment-confirmation.md) is built, P0
through P2, and so are the two follow-ups the P2 list never named. The next
direction is a choice rather than a queue.

Phase 10 is committed and pushed. What landed on top of Phase 9:

- **The channel is editable, and `none` is no longer a one-way door.** That was
  the real bug behind "reminderPreference is not editable in the UI": the form
  only rendered for a client who was *not* on `none`, so putting somebody there
  — by seed, by import, or by their own `STOP` — required a database edit to
  undo. The cadence select still hides for those clients; the channel above it
  does not. Fields are validated one at a time, because a form demanding a
  cadence would drop the very submission that turns the messages back on.
- **A cadence control on the client's own door**, and the line it stops at.
  `reminder_cadence` is a new resource, so the `client` role now reaches exactly
  two cells and the matrix is 588. The door may narrow how many reminders a
  client gets and may never touch the channel — a leaked link that leaves
  somebody on one message is strictly less harmful than one that cancels their
  session, which this door already does, whereas one reaching `none` would end
  the messages and the fee together and nothing would notice.
- **A capstone pass on the demo.** Two 60-second walkthroughs, the confirmation
  loop first. Three new screenshots: the front-desk work lists, the client's
  door in Spanish, and the confirmation report.

Gate at this commit: unit **1915/1915**, typecheck clean, e2e **68/68** against
a production build, seed green on **all forty-four** metrics.

**The screenshot pass found a defect no test could have.** Capturing the client's
door in Spanish showed two identically-worded reason pickers stacked under one
appointment — one attached to a cancellation with a fee on it, one to a request
that changes nothing. Every spec passed. Worth remembering the next time a
screenshot refresh looks like a documentation chore: it is the only review in
this project that looks at a whole screen at once.

**Three things worth knowing before building on this.**

1. **`npm run shots` now runs a horizon tick and a carrier tick first.** The
   seed's cadence stops at its frozen `TODAY` while wall time moves on, so
   without the catch-up every "awaiting reply" surface photographs empty. If a
   capture comes back looking dead, that is the first thing to check.
2. **The narrow-door guard fires on every field added to `openPortal`.** It has
   caught three now. Each addition is justified in the spec rather than waved
   through, and that is the intended cost.
3. **The seed does not roll for per-client attributes.** Language and anything
   else derived from the client number rather than `chance()`, because one extra
   draw moves the whole stream and breaks metrics unrelated to the change.

Where this could go next, in no particular order and none of it queued:

- **An adversarial review of the fee path.** Four preconditions have accumulated
  across five phases — allowed to ask, delivery proven, answerable in time, and
  a body in a language the client reads. Each was added when the one before it
  proved insufficient. The value now is in whether they *compose* correctly, not
  in whether each works alone, and nobody has read them together as somebody
  trying to find the indefensible charge.
- **A third language.** The checklist is enforced rather than written down: add
  the enum value and the suite refuses to build until the templates, deny-list,
  weekday names and portal copy are complete, and the keyword collision test
  refuses a token meaning "yes" in the new language and "no" in an existing one.
- **The intake forms in Spanish.** The honest stopping point of the language
  work, and not a copy task: a screener's wording is clinically validated per
  language and a mistranslated item changes what the score means.
- **Authentication.** Still the largest named gap, still deliberately unbuilt —
  `requiresSecondFactor` is the policy, the dev switcher is the seam, and a
  login that always succeeds would be worse than none.

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so
this policy's fee falls hardest on the clients least able to answer, and the
practice learns about it as attrition rather than as complaints. Five phases of
preconditions have removed ways of charging the *wrong* people — the unasked,
the unreached, the reached-too-late, the client who cannot read the message —
and none of them touches capacity, which is what Risk 1 is about. The number to
look at before defending the money is the seeded quarter's confirmation report,
and `autoNoShowOnNoResponse = false` is one row if it reads badly.

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

- `INBOUND_WEBHOOK_SECRET` **and** `DELIVERY_WEBHOOK_SECRET` must be set in
  `.env`, `.env.test` and `.env.e2e`, or those routes refuse every request. That
  refusal is deliberate; see the two files under `app/api/`.
- **Postgres must be running before anything.** `service postgresql start` on a
  fresh container; the databases survive but the server does not.
- **Playwright browser:** set `PLAYWRIGHT_CHROMIUM_PATH` to a system Chromium and
  the sweep uses it; unset, Playwright downloads its own pinned build. On this
  image that is `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` — note it
  is the versioned directory, not `/opt/pw-browsers/chromium/`.
- **A schema change needs `npm run db:generate`** before `typecheck` will
  believe it, and `db:migrate:test` + `db:migrate:e2e` before either suite runs.
  `npm run db:migrate:all` does all three databases.
- Seeded client phone numbers are the full ten-digit fictional form
  (`555-555-01NN`). The seven-digit form they replaced fails
  `plausibleDestination`, which is the carrier being right rather than the check
  being wrong — but it made every sms client undeliverable, so it is worth not
  reintroducing.
