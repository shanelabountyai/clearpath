# Next

**Item:** P2 — queue assignment with capacity signalling, done. Committed and
pushed as `f951549`.

- `Inquiry.assignedClinicianId`, separate from `requestedClinicianId` — one is
  what the caller said, the other what the practice decided.
- Assignment is `update` on `inquiry`, an existing cell. No new action, and a
  clinician still cannot assign one (including to themselves).
- **New resource `capacity` and a new rule `self`** (`Target.subjectUserId`).
  Clinicians `read: always, update: self`; front desk and admin `read` only.
  Admin's missing `update` is the deliberate one — the only non-clinical cell
  the practice manager is denied on that page, with no break-glass.
- `User.acceptingNewClients` is the declared half. Caseload and queue depth are
  measured off existing rows via a filtered relation count — no column.
- Assigning to a closed clinician succeeds, with the warning on the row.
- `setCapacity(actor, accepting)` takes no subject id, and the form has no
  hidden field for one.
- Page draws the toggle and the "Yours" filter from
  `may(… 'capacity', { subjectUserId: actor.id })`, never a role check.
- Migration `20260909224719_inquiry_assignment_capacity`, applied to dev, test
  and e2e. Seed: Rosa and Kai closed; 3 of the 5 open enquiries in a queue.
- PRD box ticked, D-09/D-10 added, `WRITEUP.md` §26 and 8 decision-log rows.

## Gate at this commit

Unit **2321/2321** (27 files). e2e **42 passed, 1 skipped** (`screenshots.spec.ts`,
gated on `SHOTS=1` — pre-existing). Typecheck clean. Dev, test and e2e databases
migrated and reseeded.

## What's actually next

One P2 item left in `prd-intake-inquiry.md`, still open and undecided:

- **Referral-source detail for `gp` / `referred_out`** — which practice, which
  doctor. Turns a code into an entity with its own model. Small and contained:
  a schema addition, a picker on the record-a-call form, and export/report
  plumbing. Sonnet is a fine fit for it.

No other PRD has open, verified-missing work. Ask whether to take it, or stop
here — the intake PRD is otherwise complete.

Two loose threads, neither urgent:

1. The public form's throttle read-then-write can let one extra submission
   through under a genuine race. Carries a `ponytail:` comment naming the fix.
   At three an hour it is not worth a lock.
2. A clinician on leave who left their books open is a wrong signal nobody else
   can correct — that is D-09's stated cost, not a defect. The practice fixes it
   by asking them.
