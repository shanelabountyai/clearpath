# Next

**Item:** the last named P2 item is done. The practice writes in English and
Spanish, and the deny-list that decides what a message may not say now speaks
both — which was the half of "multi-language" that was a privacy hole rather
than a copy task.

**Every requirement in [prd-appointment-confirmation.md](prd-appointment-confirmation.md)
is now built, P0 through P2**, except the two items below that were never on
its list.

Phase 9 is committed and pushed. What landed on top of Phase 8:

- **`Client.language`** — `en` / `es`, default `en`. Message bodies, the
  deny-list, the inbound keyword lists and the client's own page are all keyed
  by it.
- **A body is vetted against every shipped language's list, not the client's
  own.** The person reading a lock screen is whoever is standing there.
  Comparison folds accents, which closed a gap nobody was hunting: the Spanish
  `clinic` catches the bare English word, which the English list never had — it
  listed `clinical` and stopped.
- **An untranslated template is not sent, and so can never be charged for.**
  Not an English fallback: that would count an unreadable message as having
  asked. A completeness test forbids a partially translated language outright,
  so the runtime branch is a safety net rather than a plan.
- **A keyword meaning opposite things in two languages resolves to `unparsed`.**
  No collision exists between English and Spanish; the rule is for the third
  language. Opt-out keywords stay English because the carrier and the regulator
  recognise `STOP` whatever the client speaks — `PARAR` is honoured as well.
- **The client's door is translated**, weekday names and fee disclosure
  included, and front desk sees the language on the client record with a picker
  beside the cadence one.

Gate at this commit: unit **1823/1823**, typecheck clean, e2e **60/60** against
a production build, seed green on **all forty-four** metrics.

**The number worth reading.** A translated client is charged at **4.48%**
against the practice-wide **4.57%**. The claim is deliberately *not* "Spanish
speakers are never charged" — that would be a different and worse policy,
patronising in one direction and unfair in the other. It is that they are
charged at the same rate, because they were asked in a language they read.

**Three things worth knowing before building on this.**

1. **The seed does not roll for language**, per the previous handoff's warning
   about `chance()` in the client block. Every fifth client reads Spanish,
   derived from the client number, so all pre-existing figures are unchanged —
   charge rate included. Keep doing this: any new per-client attribute should be
   derived rather than rolled unless the distribution genuinely needs dice.
2. **`openPortal` has a spec pinning the exact set of keys it returns.** Adding
   `language` failed it, which is the guard working. If you add a field there,
   expect to justify it in that spec rather than to update a number.
3. **The intake forms are still English, and that is the honest stopping
   point.** A screener's wording is clinically validated per language and a
   mistranslated item changes what the score means. It is not a copy task and
   should not be done by anybody who cannot validate the result.

What is left, none of it from the PRD's P2 list:

- **A portal control for the cadence.** The obvious next step now the field
  exists, and it needs a think rather than a form: a forwarded link should not
  be able to change how somebody is contacted, so it is a question about what a
  tokenized link may do before it is a question about a `<select>`.
- **Editing `reminderPreference` in the UI.** Still the visible gap it became
  two phases ago — the cadence and language pickers now sit directly under a
  channel the same screen can only display. The machinery exists; it is a form.
- **A third language, when the practice needs one.** The checklist is enforced
  rather than written down: add the enum value, and the suite will refuse to
  build until the templates, the deny-list, the weekday names and the portal
  copy are all complete. The keyword collision test will refuse a token that
  means "yes" in the new language and "no" in an existing one.

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so
this policy's fee falls hardest on the clients least able to answer, and the
practice learns about it as attrition rather than as complaints. Nothing in this
phase touches it — a client who could not read the message is now exempt, which
removes a way of charging the wrong people, but Risk 1 is about capacity rather
than comprehension. The number to look at before defending the money is still
the seeded quarter's non-response rate on `/reports`, and
`autoNoShowOnNoResponse = false` is one row if it reads badly.

**Two earlier decisions, accepted by the owner on 2026-09-05 and not reopened.**
`STOP` stays a fourth classification that sets `reminderPreference = 'none'` and
sends nothing back; the auto-reply keeps "call or text 988 at any hour" rather
than the deny-listed phrase "crisis line". The Spanish auto-reply says the same
thing the same way, and `crisis` is spelled identically in both languages, so
the constraint did not need re-deriving.

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
