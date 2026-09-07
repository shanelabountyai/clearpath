# Next

**Item:** P2-3 (per-client cadence selection) is done, committed and pushed.
One P2 remains:

1. **Multi-language message bodies.** The deny-list is English-only and would
   need one per language. Widest surface, lowest leverage — and it is a
   correctness path, not routine build: `messaging/inbound.ts` matches whole
   keywords, and `indiscreetTerms` is what stops a lock-screen disclosure.
   Opus-shaped if it is picked up. Otherwise: start a new PRD.

## What landed this session

**P2-3 — the client's own answer to the volume question, and the reduction that
must not stack with the cap.** `Client.reminderStages` is an empty-by-default
list of the same three stages the rule already speaks in. Empty means the
practice cadence, streak cap and all; a non-empty list is the client's
selection.

- **It wins over the cap rather than intersecting with it.** Intersecting a
  chosen `d0` with a capped `d1` is the empty set — a client who asked for
  *fewer* messages would be silenced entirely, and not on the day somebody
  ticked the box: four confirmations later, on the client whose distinguishing
  feature is that they reliably answer.
- **It narrows and never promotes.** `dueStages` applies every rule it applied
  before, so a `d5`-only client booked three days out still gets nothing.
- **`reminderPreference: 'none'` still outranks it** — a selection is *which*
  stages, never *whether*, and the checkboxes do not render for a client on it.
- **The fee rests on the same evidence.** Where a selection queues something,
  the promotion to `pending`, the outbox row and the delivery receipt are
  unchanged. Fewer messages is still a message.
- **No new query in the horizon run.** A client with a selection needs no track
  record read at all, so the run does *less* work for them, not more.
- **Reused `updateClient`**, which is already guarded and audited — no new
  repository verb, no new permission resource.

Seeded pair, deliberately: TC-051 confirms four times and is capped to the day
before; TC-056 confirms four times *and* chose the day of. Same history,
different cadence — TC-056 is the row that would have gone silent under an
intersection.

## Gate at this commit

Unit **1589/1589** (was 1579), typecheck clean, e2e **24/24** against the
production build. Migration `20260907191212_client_reminder_stages` applied to
dev, test and e2e — **it is not yet on production**; `npm run db:migrate:prod`
when that matters.

No new e2e spec: `denials.spec.ts` already crawls `/clients/[id]` as every
seeded role, so the new form's rendering and its permission gate are exercised.
The rule is unit-tested in `confirmation.test.ts` and the wiring in
`reminders.test.ts` ("the stages a client picked for themselves").

## Deliberately not done

- **No per-stage channel.** "Email at five days, text on the day" is a second
  dimension on the same field and nobody asked for it.
- **No client-facing control.** The portal has no settings surface, and giving
  it one is a bigger question than this field: the client who can mute their own
  reminders is the client the no-show fee then charges for silence.
- **No practice-wide default set of stages.** That is what the cadence already
  is; a second place to express it is the disagreeing-fields bug again.

## Still open, answered but not actioned

The "refer a friend" growth motion is off — anti-kickback, state
patient-brokering, ethics codes, and a referral program cannot be built without
linking two clients' records. The defensible version is a fixed-list
`referralSource` field at intake: attribution only, no credit, no link between
client records.
