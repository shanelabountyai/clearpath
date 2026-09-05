# Next

**Item:** the appointment confirmation loop is **complete through P1**. What
remains in [prd-appointment-confirmation.md](prd-appointment-confirmation.md) is
the P2 list, and the first of those is the one that changes what the feature is
allowed to claim.

Phase 5 is committed and pushed. What landed on top of Phase 4:

- **P1-2, the cadence cap.** `cadenceCapped(history, cap)` in
  `confirmation.ts`, wired through `dueStages` via `ConfirmationSettings.capped`.
  A client who confirms `confirmationStreakCap` times running (default 4) drops
  to `d1` alone until they miss one. **The streak is derived from appointment
  history, not stored** — `recentAnswers` in `reminders.ts`, bounded to three
  weeks per session. Measured on the seeded quarter: 1,168 reminders where the
  uncapped cadence sent 1,355, with the answer rate and fee count unchanged.
- **P1-3, inbound replies.** `classifyReply` (pure) and `handleInboundReply` in
  `src/messaging/inbound.ts`; `POST /api/inbound` behind a shared secret;
  `npm run inbound:simulate`. `InboundReply` has **no body column** and a grep
  test refuses any write that adds one. `unparsed` raises an `inbound_unparsed`
  alert to the treating clinician, sends the auto-reply, and lands on the
  front-desk list as "call them".
- **P1-4**, `confirmationReport` in `src/reports/utilization.ts`, on
  `/reports`. **P1-5**, a decline carries one of the portal's four reason codes.

Gate at this commit: unit **1622/1622**, typecheck clean, e2e **32/32** against
a production build, seed green on **all twenty-two** metrics (34 charges from
692 eligible, 4.91%; 148 sessions on the capped cadence; 2 replies waiting for
a phone call).

**Two decisions the owner should accept or reject before this ships anywhere.**

1. **`STOP` is a fourth classification, which the PRD did not specify.** Read as
   a decline it cancels a session the client never mentioned; read as
   `unparsed` it earns an auto-reply, and replying to an opt-out is the one
   thing a carrier forbids. It now sets `reminderPreference = 'none'` and sends
   nothing back. If that is wrong, it is one branch in `classifyReply` and one
   in `handleInboundReply`.
2. **The auto-reply names no crisis line, because `crisis` is on the
   deny-list.** It says "If you need urgent help right now, call or text 988 at
   any hour" instead. Both requirements were right and could not both be met
   literally; this keeps the information and loses the label. Worth a read by
   whoever owns the clinical copy.

P2, in the order that matters:

- **A real carrier behind the outbox, with delivery receipts.** This is the
  single biggest honesty upgrade available and it is not optional for a real
  deployment. Today the fee's precondition is a *queued* message, which proves
  the practice intended to ask. With a carrier attached it must become a
  delivery receipt, or the practice charges clients for its own failed sends.
  The metric `every non-response fee has an outbox row behind it` in
  `prisma/metrics.ts` is where that change lands.
- **Confirmation state feeding the waitlist.** A decline at `d5` is a
  five-day-notice opening, which is exactly what a waitlisted client can take.
  `waitlistMatches` already exists and takes a slot.
- **Per-client cadence selection** — a client who wants only the day-of nudge.
  The cap made the machinery for this: `ConfirmationSettings.capped` is already
  a per-client property threaded through a pure function.
- **Multi-language message bodies.** The deny-list is English-only and would
  need one per language. A real gap, and named.

**The standing recommendation, unchanged and not withdrawn.** Risk 1: in
counseling, non-response correlates with the reason people are attending, so
this policy's fee falls hardest on the clients least able to answer, and the
practice learns about it as attrition rather than as complaints. Everything
defensible now ships — the loop, the work list, the cap, the report. The number
to look at before defending the money is the seeded quarter's non-response rate
on `/reports`, and `autoNoShowOnNoResponse = false` is one row if it reads
badly.

Still open from earlier, answered but not actioned: the "refer a friend" growth
motion is off (anti-kickback / state patient-brokering / ethics codes, and a
referral program cannot be built without linking two clients' records). The
defensible version is a fixed-list `referralSource` field at intake —
attribution only, no credit, no link between client records.

**Local setup notes.**

- `INBOUND_WEBHOOK_SECRET` must be set in `.env`, `.env.test` and `.env.e2e`, or
  `/api/inbound` refuses every request. That refusal is deliberate; see
  `app/api/inbound/route.ts`.
- `playwright.config.ts` expects Playwright's own browser download. On a machine
  that ships a system Chromium instead, add
  `launchOptions: { executablePath: ... }` to `use` for the sweep — not
  committed, because pinning a path would break the ordinary install.
