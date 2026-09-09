# Next

**Item:** P2 — retention windows per discard reason, done.

- `PracticeSettings` gains `spamRetentionDays` (default 7) and
  `referredOutRetentionDays` (default 365), same override pattern as the
  existing `inquiryRetentionDays`. Every other discard reason still ages out
  on the general window.
- `purgeCutoff` became `purgeWhere` in `src/clients/inquiry.ts` — one shared
  `OR` of per-reason cutoffs, read by both `runInquiryPurge` and
  `previewInquiryPurge` so the two candidate sets cannot drift.
- Migration `20260909183340_inquiry_retention_by_reason` applied to both
  `clearpath_dev` and `clearpath_test`.
- Practice settings page (`app/(staff)/practice/page.tsx`) shows the two new
  fields alongside the existing retention line — read-only, same as the rest
  of that page.
- 3 new tests in `src/clients/inquiry.test.ts` (per-reason window, general
  window unaffected, settings override on a per-reason field).
- PRD checkbox ticked in `prd-intake-inquiry.md`; `WRITEUP.md` has two new
  learning-artifact rows.

## Gate at this commit

Unit **1959/1959** (was 1956, +3 new). Typecheck clean. Not re-run: full e2e.

## What's actually next

The other three P2 items in `prd-intake-inquiry.md` are still open and
undecided: public inquiry form, clinician queue assignment with capacity
signalling, referral-source detail (`gp`/`referred_out` → practice/doctor
entity). Ask the user which, if any, to pick up next — no PRD has other
open, verified-missing work.
