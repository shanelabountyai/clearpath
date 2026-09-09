# Next

**Item:** P1-3 is done. Last item on `prd-intake-inquiry.md`: **P1-4 — purge
preview** (what the next sweep will destroy, so the window is visible before
it fires rather than after). Finishes the intake PRD.

## Model

**Sonnet fits P1-3's shape, but check P1-4's before starting.** If the
preview is just `runInquiryPurge`'s own candidate query with the delete
swapped for a read (likely — the due-set logic already exists in
`runInquiryPurge`), Sonnet is still right: a read path over an existing query,
no new authorization shape. Switch to Opus only if it turns out to want a new
matrix cell or its own read path with different scoping.

## What P1-3 landed

- `staleInquiries(actor, opts)` in `src/scheduling/worklists.ts` — open
  inquiries older than `olderThanDays` (default 3), oldest first. Shape is
  `continuityQueue` read against `Inquiry` instead of `Client`.
- New "Calls nobody has closed out" section on `/worklists`, between
  "Nobody has said they are coming" and "Continuity of care".
- 4 unit tests (`src/reports/reports.test.ts`), 1 e2e spec
  (`e2e/scheduling.spec.ts`), WRITEUP §23 and 1 decisions-log row.

## Traps this session hit

- **No new permission cell.** `inquiry: { read: 'always' }` already covers
  front desk, admin, and every clinician (P1-2 covers why) — same cell
  `listInquiries` reads under. Caseload scoping does not apply; don't add it.
- **The window is a function opt, not a `PracticeSettings` column.**
  Deliberate — see the decisions-log row. Don't "fix" this into a settings
  migration unless the user actually asks for the window to be configurable.
- **Backdating `createdAt` in tests needs a raw `prisma.inquiry.update`** —
  `createInquiry` takes no clock/date param, `createdAt` is a DB default.

## Gate at this commit

Unit **1953/1953** (was 1949, +4), typecheck clean, e2e **30/30** (was 29,
+1; 1 unrelated skip — README screenshots) against a fresh production build.

Migrations **still not on production** — five, unchanged; P1-3 added none.
Production still has no enquiries until reseeded.

## Already answered, do not re-litigate

WRITEUP §23 and its decisions-log row: three-day default as an opt, not a
settings column; `continuityQueue`'s shape reused rather than a new query
pattern; no caseload scoping, matching the `read: always` cell it reads under.
