# Next

**Item:** Appointment confirmation loop — **P1-4 and P1-5**, the cheap
follow-ons, from [prd-appointment-confirmation.md](prd-appointment-confirmation.md).

Phase 5's three committed P1s are done, committed and pushed (`16e4117`).

## What exists now

**P1-1 — front-desk work list.** `unconfirmedSoon(actor, {clock, withinHours})`
in `src/scheduling/worklists.ts`, rendered as the first section of
`app/(staff)/worklists/page.tsx`. Sessions in the next 48 hours, soonest first,
with the client's phone number on the row.

- Filters on `confirmation` NOT `confirmed`, not on `pending` — three silences
  are the same phone call (`not_required`, `pending`, and a `declined` session
  still standing, which is what a keyword decline leaves behind).
- `status: 'scheduled'` only, so an hour front desk confirmed by hand drops off.
- No new matrix row and no new settings column. The window is a default
  argument (48) until somebody asks for it to be tunable.

**P1-2 — cadence cap.** `confirmationStreakCap Int @default(4)` on
`PracticeSettings` (migration `20260906171851_cadence_streak_cap`).
`cadenceStages(recent, cap)` is pure, in `confirmation.ts` beside the other two
rules. `dueStages` gained an `allowed` argument rather than a branch, so the cap
can only remove stages, never move one earlier.

- It deliberately does **not** touch the promotion to `pending`. Fewer messages
  is still a message, so a capped client's silence rests on the same outbox row
  as anybody else's.
- Only *decided* (`confirmed | declined | no_response`) and only *past*
  appointments move the streak. `DECIDED` is exported from `confirmation.ts`.
- `runReminderHorizon` caches one track-record lookup per client per run.
- Shown on `/practice` beside the other policy fields.

**P1-3 — inbound keyword handling.** `src/messaging/inbound.ts`, plus
`npm run inbound:simulate -- <phone-or-email> <message...>`. Migration
`20260906172157_inbound_replies` adds the `InboundReply` model, the
`InboundClassification` enum, `AlertKind.inbound_unparsed`, and
`PracticeSettings.practicePhone`.

- `classifyInbound` matches **whole normalised messages** against a phrase map.
  Anything else is `unparsed`. No prefix or substring matching, ever.
- **A keyword decline records `declined` and cancels nothing.** A caller ID is
  not a credential; the fee interstitial cannot happen in a text. The hour lands
  on P1-1's list instead.
- Two clients sharing a number → `ambiguous_sender`, nothing written at all.
- `unparsed` → `Alert` to the treating clinician with `reasons: ['inbound:unparsed']`,
  plus the `inbound_unparsed_reply` template carrying the practice number and
  988/911 **as digits** (the deny-list bans "crisis" and "suicide", correctly).
- Front desk surface: "Clients who wrote back — call them" on `/worklists`,
  cleared with `resolveInboundReply`.
- Two checks: a behavioural one that plants a sentence and hunts it in every
  column it could have reached, and a structural lint that reads
  `prisma/schema.prisma` and asserts `InboundReply`'s only `String` fields are
  identifiers.

Seed: 1 client with 4 confirmations in a row (next session asked about once, not
three times), and 4 inbound replies — 1 confirm, 1 decline that freed nothing,
2 unparsed with 1 already called back.

## Phase 5 remainder to build

- **P1-4 confirmation-rate report** — per clinician and practice-wide, alongside
  the existing utilization report in `src/reports/utilization.ts` /
  `app/(staff)/reports/page.tsx`: confirmed / declined / no-response /
  not-required, and the fee total the policy generated. A `groupBy` on
  `confirmation` is most of it; `attendanceSummary` in `lifecycle.ts` is the
  shape to copy. Watch the resource: a confirmation *rate* is operational, but
  per-clinician breakdowns sit next to `attendance_history`, which front desk is
  denied — decide which cell it reads under before writing the query.
- **P1-5 decline reason codes** — reuse the portal's existing four
  (`RescheduleReason`), do not invent a parallel vocabulary. Note the tension
  worth resolving first: the portal decline currently carries no reason at all,
  and P1-3's keyword decline cannot carry one either, so this is really "ask for
  a reason on the portal decline path only".

## Gate at this commit

Unit **1552/1552**, typecheck clean, e2e **24/24** against the production build.
Migrations applied to dev, test and e2e.

## Still open, answered but not actioned

The "refer a friend" growth motion is off — anti-kickback, state
patient-brokering, ethics codes, and a referral program cannot be built without
linking two clients' records. The defensible version is a fixed-list
`referralSource` field at intake: attribution only, no credit, no link between
client records.
