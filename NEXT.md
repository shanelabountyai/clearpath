# Next

**Item:** P1-4 is done. That finishes every item on `prd-intake-inquiry.md`
(P0-1 through P0-9, P1-1 through P1-4). No item on that PRD is outstanding.

## What P1-4 landed

- `previewInquiryPurge(actor, opts)` in `src/clients/inquiry.ts`, beside
  `runInquiryPurge` — same candidate query (shared via a new `purgeCutoff`
  helper), delete swapped for a read. Reads under `inquiry: { read: 'always'
  }`, the same cell `listInquiries` uses; no new permission cell.
- `/inquiries?status=discarded` shows a "Due in next purge" badge on rows the
  preview names. The query only runs when that filter is active.
- Seed change: the fifteen discarded calls now span 8–113 days back instead
  of 8–78 (`called = 8 + i * 7`, was `× 5`) — the oldest now clears the 90-day
  retention default, so there is a seeded row for the preview and its e2e
  spec to find. Nothing else reads these rows by exact age.
- 3 unit tests (`src/clients/inquiry.test.ts`), 1 e2e spec
  (`e2e/intake.spec.ts`), WRITEUP §24 and 3 decisions-log rows.

## Gate at this commit

Unit **1956/1956** (was 1953, +3), typecheck clean, e2e **31/31** (was 30,
+1; 1 unrelated skip — README screenshots) against a fresh production build.

Migrations still not on production — five, unchanged. Production still has
no enquiries until reseeded.

## What's actually next

Not decided yet — this session didn't pick one. Candidates, unverified:

- `prd-clearpath-counseling-ops.md`'s own P1 list (No-future-appointment
  queue, co-sign aging report, auditor query UI, waitlist, utilization
  report) — several of these *look* already covered by existing code
  (`continuityQueue`, `app/(staff)/audit/export/route.ts`,
  `src/reports/utilization.ts`, `waitlistOpenings`/`waitlistMatches`), but
  that's a grep-depth read, not a checked-off item — worth 10 minutes
  confirming against the PRD's actual acceptance criteria before assuming
  any of them still need work.
- `prd-appointment-confirmation.md` still shows `[ ]` on every P0 box, but
  WRITEUP §10–17 describes the feature as built and its e2e specs
  (`portal.spec.ts`) pass — the checkboxes there look stale/unmaintained
  rather than a real signal. Worth ticking them or deleting the PRD's
  checkbox section rather than trusting it next time.

Ask the user which of these (if any) is the real next item before starting
one — don't infer it from the grep above.
