# Next

**Item:** P2-2 is done — the confirmation loop now feeds the waitlist. A
cancellation ahead of time becomes an offerable hour with the notice remaining
on it, and the waiting clients who could take it are named beside it. It is the
first thing built in this feature that is worth something to a client rather
than protecting one.

Phase 7 is committed and pushed. What landed on top of Phase 6:

- **A pure match rule** (`src/scheduling/openings.ts`). `openingSuits` reads
  three things and the order is the design: **continuity first**, then the
  client's stated weekdays, then their time window. A `WaitlistEntry` belongs to
  a `Client` and every client has a non-null `treatingClinicianId`, so offering
  somebody another clinician's free hour is proposing they see a stranger. It is
  checked before anything the client asked for because no preference outranks
  it. `fillability` and `describeNotice` are a band and a label — no money, no
  filter, no branch.
- **`freedSlots`** in `worklists.ts`: every future cancellation, **not only the
  declines**. A front-desk cancellation empties the same hour, and a list of
  declines would leave holes nobody was looking for. Four filters, all derived,
  no "handled" button: an hour somebody was rebooked into is not free (which is
  also what makes group sessions behave — one attendee dropping out leaves the
  clinician running the group), an hour the clinician is not working is not free
  either, one hour is one opening however many cancelled rows point at it, and
  the hour has not started. Nothing else is hidden.
- **Two surfaces.** `/worklists` replaces the old Waitlist section; `/calendar`
  banners the freed hours on the day shown and links across.
- **The seed gives hours back.** Six of the coming month's sessions through the
  same `cancelAppointment` the desk uses, half as declines and half as calls,
  plus one inside the vacation week that must *not* appear.

Gate at this commit: unit **1733/1733**, typecheck clean, e2e **49/49** against a
production build, seed green on **all thirty-two** metrics, determinism verified
by diffing two runs.

**The numbers this phase was for.** Eight offerable hours in the coming month,
**five with somebody waiting and three with nobody** — and the three are as much
the point as the five, because the hour nobody can take is exactly the one that
otherwise goes empty without anybody noticing. Zero cross-clinician offers, zero
offers back to the client who cancelled, zero hours offered from a week a
clinician is away. All four are seed metrics rather than claims.

**Three things worth knowing before building on this.**

1. **A real bug was hiding behind a `.catch`.** The old page called
   `waitlistMatches` with an invented slot (tomorrow at 3pm) and wrapped it in
   `.catch(() => [])`. That catch was swallowing a genuine authorization denial:
   `client:read` for a therapist is `treatingOrSupervising`, the call passed no
   target, and every clinician who opened that page got a silent empty list where
   the system had actually refused them. Both are fixed, and the therapist path
   now has a test that failed the first time it ran. **Worth grepping for other
   `.catch(() => [])` on guarded calls** — `openRescheduleRequests` on the same
   page still has one.
2. **The seed is anchored at `2026-09-01` and real time drifts past it.** This
   feature is the first forward-looking list, so it is the first to feel it: the
   quarter's own declines free almost nothing ahead of "today", which is why the
   seed now gives sessions back across the horizon explicitly. As wall-clock time
   advances the give-back window will eventually fall behind, and `/worklists`
   will go quiet. That is a property of a fixed-date seed, not of this feature,
   and it will bite the next forward-looking thing too.
3. **No offer is recorded.** Front desk can ring the same three people about two
   different hours and this system will not know. That was a deliberate fork —
   the alternative is a table, an audit story, and a new way for an opening to be
   dismissed without being filled — but it is the first thing to revisit if
   somebody actually uses this. The fix is a record of offers, not a dismiss
   button.

P2, in the order that matters now:

- **Per-client cadence selection** — a client who wants only the day-of nudge.
  The cap already made the machinery: `ConfirmationSettings.capped` is a
  per-client property threaded through a pure function. Mostly a settings-UI
  problem, and now the largest remaining P2 item.
- **Multi-language message bodies.** The deny-list is English-only and would need
  one per language. Still *two* gaps, not one: the deny-list and the inbound
  keyword lists in `classifyReply`.

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so this
policy's fee falls hardest on the clients least able to answer, and the practice
learns about it as attrition rather than as complaints. Phase 6 removed one way
of being wrong — charging for the practice's own failed sends. This phase did not
touch it either; it is the first phase that gives a client something rather than
protecting one, which is a different axis and not a mitigation. The number to
look at before defending the money is still the seeded quarter's non-response
rate on `/reports`, and `autoNoShowOnNoResponse = false` is one row if it reads
badly.

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
- Seeded client phone numbers are the full ten-digit fictional form
  (`555-555-01NN`). The seven-digit form they replaced fails
  `plausibleDestination`, which is the carrier being right rather than the check
  being wrong — but it made every sms client undeliverable, so it is worth not
  reintroducing.
