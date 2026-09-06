# Next

**Item:** nothing outstanding. Every requirement in
[prd-appointment-confirmation.md](prd-appointment-confirmation.md) is built, P0
through P2, the two follow-ups the P2 list never named are built, and the
adversarial review the last handoff proposed has been done and has landed. The
next direction is a choice rather than a queue.

Phase 11 is committed and pushed. What landed on top of Phase 10:

**The review found a real one, and it was the biggest fee bug in the feature.**
Four preconditions had accumulated across five phases — allowed to ask, delivery
proven, answerable in time, a body in a language the client reads. Every one of
them asks a question about the *message*. Not one asks whether the message is
still about **this appointment**.

`rescheduleAppointment` wrote `startAt`, `endAt`, `roomId`, `type`, `modality`,
the series detach and the group key, and nothing else. So a session that had
been asked about in full kept `confirmation: 'pending'` and kept every reminder
row whose message named the old time — and all four preconditions passed on
that evidence. `answerable` passed *more easily the further the session moved*,
because it measured the old `deliveredAt` against the new `startAt`. The sweep
then charged ninety dollars for silence about a question the practice itself
withdrew. A surviving `confirmed` was the same defect without the money: the
schedule carrying a record that a client agreed to a time nobody put to them.

The fix, in three parts:

1. **`Appointment.bookedAt`**, stamped from the injected clock at booking and
   again at every reschedule. `createdAt` is when the row was made;
   `bookedAt` is when the hour it names was set, and every confirmation rule
   wanted the second. `confirmationRequired` measures notice from it and
   `dueStages` will not queue a stage whose moment fell before it.
2. **`AppointmentReminder` re-keyed to `(appointmentId, stage, dueAt)`.** The
   old key blocked the cadence from re-asking after a move. Deleting the old
   rows was the cheap way out and the wrong instinct on this feature — they are
   the only proof the practice ever asked. `dueAt` derives from `startAt`, so
   the key still catches two horizon runs racing, and now also says a moved
   appointment is a different question.
3. **The sweep filters its evidence on `dueAt >= bookedAt`** — the same
   predicate `dueStages` uses, read back at the moment of the fee.

Plus two structural lints: every `appointment.create` names both `createdAt`
and `bookedAt`, and every `appointment.update` whose `data` writes `startAt`
must write `bookedAt`. The second is for the move nobody has written yet — a
drag-and-drop calendar, a bulk shift for changed availability, a script nudging
a day by fifteen minutes.

Gate at this commit: unit **1919/1919**, typecheck clean, e2e **68/68** against
a production build, seed green on **all forty-eight** metrics.

**Three things worth knowing before building on this.**

1. **The seeded quarter now moves five sessions on the day, in both
   directions.** Moving later leaves room for the cadence to re-ask, so the
   client is charged like anybody else; moving earlier leaves none, so nobody is
   charged. A fixture that only did one would prove the rule it happened to
   exercise and hide the other. The charge rate fell 4.57% → **4.28%** (29 of
   677), which is two clients — the correct size for this finding, because the
   bug was rare and indefensible every time.
2. **`npm run shots` runs a horizon tick and a carrier tick first.** The seed's
   cadence stops at its frozen `TODAY` while wall time moves on, so without the
   catch-up every "awaiting reply" surface photographs empty. If a capture comes
   back looking dead, that is the first thing to check.
3. **The seed does not roll for per-client attributes.** Language and anything
   else derived from the client number rather than `chance()`, because one extra
   draw moves the whole stream and breaks metrics unrelated to the change.

**The method is the transferable part.** The review's rule was: no finding is a
finding until a spec fails on it. Three specs were written before a line of the
fix, and the third — "asks again about the new hour" — is what turned a
one-field reset into a schema change, because resetting `confirmation` alone
would have moved a client to a new time and never told them. A finding stated in
prose would have shipped the one-field version.

Where this could go next, in no particular order and none of it queued:

- **Record the rendered language, and the hour, on `OutboxMessage`.** The same
  shape of bug as the one just fixed, one step along: a client whose record is
  corrected from `en` to `es` still has delivered English reminders counting as
  having asked, and there is no language column to check it against. Adding
  `appointmentId` and `language` to the message would also make the
  appointment→message trail survive independently of `AppointmentReminder`.
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
practice learns about it as attrition rather than as complaints. Six phases of
preconditions have removed ways of charging the *wrong* people — the unasked,
the unreached, the reached-too-late, the client who cannot read the message, and
now the client asked about an hour that no longer exists — and none of them
touches capacity, which is what Risk 1 is about. The number to look at before
defending the money is the seeded quarter's confirmation report, and
`autoNoShowOnNoResponse = false` is one row if it reads badly.

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
