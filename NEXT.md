# Next

**Item:** A fourth PRD — `prd-clinician-departure.md`, written. Document only,
no code, gate untouched.

## What it is

Clinician departure: the caseload transfer, and the note nobody may sign. Chosen
over records-release and a supervised-hours ledger because it stresses the two
rules the whole codebase rests on — `process_note.read: 'author'` and
append-only audit — at the exact point they break, which is the day the author
leaves.

Four things in it are load-bearing, and three were verified against the code
before being written down:

1. **`User.active = false` is the entire current mechanism**, and it does two
   things: `session.ts:45` blocks login, `session.ts:69` drops them from the
   person picker. Nothing else moves — fifteen `Client.treatingClinicianId`
   rows, live series, unsignable drafts, unreadable process notes, orphaned
   alerts, open books.
2. **`progress_note.read` is `authorOrSupervisor`, but `form_submission` is
   `treatingOrSupervising`.** So the official record is the only clinical
   resource on a client narrower than the record around it, and a receiving
   clinician can read a client's risk scores but not their notes. Departure is
   the first event that exposes it. D-04 widens the cell in the matrix, not in
   the transfer.
3. **`appointment_clinician_no_overlap` is an exclusion constraint**, so a bulk
   caseload move can be refused by the database mid-transaction. The PRD
   validates conflicts continuously from notice and rolls the whole departure
   back at execution (D-06, D-07) rather than moving what fits.
4. **`departure.create` closing a clinician's books** is the narrow, named path
   that answers intake D-09's stated cost (NEXT.md loose thread #2 from last
   session). Admin still cannot mark anyone *open* — the asymmetry is D-10.

14 decisions, 11 P0s in four phases, five P1s, four P2s.

## Gate

Unchanged — markdown only. Last verified at `92d9f06`: unit **2455/2455** (27
files), e2e **45 passed, 1 skipped**, typecheck clean. `*.md` is excluded by the
Vercel `ignoreCommand`, so this push does not build.

## What's actually next

Nothing is queued. Two obvious continuations:

1. **Build Phase 1 of the departure PRD** — matrix cells and every denial, the
   `progress_note.read` widening with its four claimants, the state machine.
   Pure logic, TDD, per CLAUDE.md's ordering. Opus.
2. **Ponytail audit of the finished repo** — the option not taken this session.
   Opus.

Open question the PRD itself flags as its weakest point: the new read rule's
name. `recordReader` names a role; every other rule in `permissions.ts` names a
relationship. Settle it in Phase 1, not before.

Three loose threads from before, one now answered:

1. Public form's throttle read-then-write race. Carries a `ponytail:` comment.
   Still not worth a lock at three an hour.
2. ~~A clinician on leave with their books left open~~ — the departure PRD's
   P0-9/D-10 answers this for a *departure*. A leave of absence is P2 and still
   has no mechanism.
3. Design brief §5b/§5c components with no picture. Still inventory, still not a
   component library.
