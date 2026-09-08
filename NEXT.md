# Next

**Item:** Phase 3 of `prd-intake-inquiry.md` — P0-7 (the waitlist accepts an
inquiry), P0-8 (`convertInquiry`), P0-9 (`referralSource` on `Client` + the
enum/fixture equality test).

Phase 2 landed the table, the trigger and the purge (`0891650`). Read D-04 and
the P0-7/P0-8 bullets before deviating.

## Model

**Opus.** P0-7 puts the schema's only `ON DELETE CASCADE` next to the only
`DELETE` path, and P0-8 is a multi-write transaction that has to repoint a
waitlist entry without ever letting a purge and a conversion be true at once.
Both are correctness decisions with a wrong answer that passes a green run.

## Phase 3, concretely

1. **`WaitlistEntry.clientId` nullable, `inquiryId` added, `CHECK` requiring
   exactly one.** `inquiryId` is `ON DELETE CASCADE` — the only cascade in the
   schema, and it is what makes the purge safe. Verify the `CHECK` against
   seeded data before the nullable column lands, in the style of the
   localized-labels migration.
2. **`ENTRY_SELECT` gains the inquiry branch** in `scheduling/worklists.ts`.
   `fits()` is unchanged — it already reads only weekday and window.
   `waitlistOpenings`' "never offer a client the hour they just gave back"
   comparison skips inquiry entries, which by construction gave nothing back.
   The worklist row says *inquiry*: no client code, no treating clinician.
3. **`convertInquiry(actor, id, { code, dateOfBirth, treatingClinicianId, ... })`**
   — one transaction via `guardedAll`: create the `Client`, set
   `Inquiry.clientId` and `status = 'converted'` through `assertTransition`,
   repoint the waitlist entry, copy `referralSource`/`referralNote`. Adds
   `Inquiry.clientId` (the column deliberately left out of Phase 2). Sending the
   intake packet is the caller's next step, never a hidden side effect.
4. **`ReferralSource` on `Client`** (the enum already exists), plus the test
   asserting its values equal `intakeForm`'s `referral` options exactly.

## Traps

- **The audit rows for a conversion carry the *client* id**, unlike every
  inquiry row Phase 2 writes. `clientId: null` is the rule for rows *about an
  inquiry*; once there is a client record, the column means what it says.
- **A converted inquiry is already unpurgeable** — the Phase 2 trigger refuses
  it. Do not add a second check for that in the sweep.
- **`Inquiry.clientId` must not become a route from a client to a note.** The
  Phase 2 structural tests (`inquiry.test.ts`, bottom of file) will fail the
  build if a clinical relation appears; `Client` is not on that list, so the
  conversion column is legal — check the test still says what you mean after.
- **The seeded quarter is not written yet.** P0-1's ~40 inquiries (~20
  converted, ~15 discarded, ~5 open) belong with P1-1's report, not before it.

## Gate at this commit

Unit **1922/1922** (was 1907 — +15 inquiry record, trigger, purge and
structural tests), typecheck clean. e2e not re-run: nothing in this commit
renders a page. The new migration is applied to dev, test and e2e.

Migrations **still not on production** — four now:
`20260907191212_client_reminder_stages`, `20260907194526_client_language`,
`20260908103000_localized_form_labels`, `20260908213312_inquiry_intake`.
`npm run db:migrate:prod` when that matters.

## Already answered, do not re-litigate

- `discard` not `delete`; clinicians create but do not discard — WRITEUP §18.
- `Inquiry` separate from `Client`; the trigger over an application check; the
  audit trail pointing at a destroyed row — WRITEUP §19.
- Nothing is ever sent to an inquiry (D-05). No outbox, no portal, no consent.
- The purge has no scheduler and does not need one — same call shape as
  `reminders:run`. Wire it to the existing scheduled path when there is one.
