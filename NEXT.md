# Next

**Item:** P2-2 (confirmation state feeds the waitlist) is done, committed and
pushed at `a8a8e7b`. Nothing is queued — pick the next thing from
[prd-appointment-confirmation.md](prd-appointment-confirmation.md)'s P2 list, or
start a new PRD.

Two P2s remain, in the order they are worth doing:

1. **Per-client cadence selection** (a client who wants only the day-of nudge).
   Mostly a settings-UI problem on top of `cadenceStages`. Sonnet-shaped.
2. **Multi-language message bodies.** The deny-list is English-only and would
   need one per language. Widest surface, lowest leverage.

## What landed this session

**P2-2 — the openings were already in the record, written by two parts of the
system that had never been introduced.** `waitlistOpenings` in
`src/scheduling/worklists.ts` returns every appointment in the next 30 days that
is free (`cancelled`, `late_cancelled`) or about to be (`scheduled` +
`declined`), each carrying the waitlist entries that fit that hour. No schema
change, no migration.

- **The two kinds are labelled apart, not merged.** A cancelled hour is free; a
  declined one is still on the books until a human rings the client, because
  `messaging/inbound.ts` records an answer and never moves a session. Merging
  them is how a client arrives to find their room taken.
- **A client is never offered the hour they just gave back** — the most
  confident wrong row this list could show.
- **`guardedAll`, not `guarded`:** the list reads appointments *and* client
  records, so it says both, in one transaction.
- **One entry query for the whole list**, and one shared pure `fits()` predicate
  so `waitlistMatches` and `waitlistOpenings` cannot drift.
- **The page's hardcoded "tomorrow at 15:00" slot is gone.** The section now
  renders real openings with notice, kind, and matched candidates.
- **Seed already covers both kinds** — 4 openings in the e2e data, one of them
  the texted `can't make it` that leaves the hour standing. Only the seed's log
  line changed ("a decline that leaves the hour standing").

## Gate at this commit

Unit **1579/1579** (was 1577), typecheck clean, e2e **24/24** against the
production build. No migration, so nothing to apply; e2e db reseeded by the
sweep.

No new e2e spec: `denials.spec.ts` already crawls `/worklists` as every seeded
role, so the new section's rendering is exercised. The matching and openings
rules are unit-tested in `src/reports/reports.test.ts` ("the waitlist").

## Deliberately not done

- **No notice threshold.** Notice is shown and the list sorts by start; "too
  short to bother with" is a front-desk judgement, not a constant.
- **No clinician filter on candidates.** Whether a different therapist's
  waitlisted client is an offer at all is a clinical question about caseloads,
  not one a filter should silently answer.
- **No "offer" action.** Still a list of phone calls. Booking from a decline a
  forged text could have produced is the thing this feature must not do.

## Still open, answered but not actioned

The "refer a friend" growth motion is off — anti-kickback, state
patient-brokering, ethics codes, and a referral program cannot be built without
linking two clients' records. The defensible version is a fixed-list
`referralSource` field at intake: attribution only, no credit, no link between
client records.
