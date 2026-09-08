# Next

**Item:** build Phase 1 of `prd-intake-inquiry.md` — the permission matrix
cells and the inquiry state machine. Pure logic, TDD, per CLAUDE.md's ordering.

The PRD is committed (`8a75b2b`) and settles every architectural question,
including the one this codebase had never answered: how a row gets deleted in
a system built on append-only audit and trigger-frozen notes. Read D-01
through D-06 before deviating — each one has a rejected alternative behind it.

## Model

`opusplan` for Phase 1–3 (the design decisions are made; this is execution
against a written spec). Opus if the trigger or the audit-after-delete
behaviour turns out to argue back.

## Phase 1, concretely

1. **`Action` gains `'discard'`, `Resource` gains `'inquiry'`** in
   `src/auth/permissions.ts`. Matrix rows are in PRD P0-4 as a table.
   - This *will* fail `permissions.test.ts`'s coverage assertion until every
     role × action cell is asserted, denials included. Fill the cells; do not
     narrow the test.
   - Break-glass deliberately has no `inquiry` entry — nothing clinical there.
2. **`src/clients/inquiry.ts`** with a `TRANSITIONS` table in the shape of
   `scheduling/lifecycle.ts`: `open → converted | discarded`, both terminal,
   illegal transition raises `Conflict`.

Nothing touches the schema in Phase 1.

## Traps carried into Phase 2

- **The trigger must be asserted against a real database.** `inquiry_delete_only_discarded`
  goes in the migration, not in Prisma, and a mocked test proves nothing.
- **`AuditEvent.clientId` has no FK, and inquiry ids must never enter it.**
  That column means *a client record*. It is what lets a purged inquiry leave
  its audit rows standing with nothing dangling.
- **`WaitlistEntry.clientId` goes nullable with a `CHECK` for exactly-one.**
  Existing rows all satisfy it; verify against seeded data before the column
  lands, same care as the localized-labels migration.
- **`Inquiry.inquiryId` on `WaitlistEntry` is `ON DELETE CASCADE`** — the only
  cascade in the schema, and it is deliberate.

## Gate at this commit

Unchanged from the last session — nothing but a markdown file landed. Unit
**1616/1616**, typecheck clean, e2e **26 passed + 1 skipped** against the
production build.

Migrations **still not on production** — three:
`20260907191212_client_reminder_stages`, `20260907194526_client_language`,
`20260908103000_localized_form_labels`. `npm run db:migrate:prod` when that
matters.

## Already answered, do not re-litigate

- Group sessions and superbill depth are **shipped** (`src/scheduling/groups.ts`,
  `src/billing/superbill.ts`, WRITEUP §7 and §5).
- `referralSource` as a standalone item is **absorbed** into this PRD (P0-9).
- Both parent PRDs are fully closed, every P0/P1/P2.
