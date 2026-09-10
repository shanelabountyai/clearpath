# Next

**Item:** Phase 3 of the departure PRD — the transaction. P0-6 (the one
transaction and the all-or-nothing assertion), P0-7 (alerts), P0-8 (supervision
and the `coSignedById` `RESTRICT` change), P0-9 (the two moments). Opus.

**Do the two-line widening fix first.** It is carried over from Phase 1's
handoff and it belongs to this phase now:

- `src/notes/service.ts:29` `progressContext()` builds its target from the note
  alone (`authorId`, `authorSupervisorId`) and never resolves the client's
  current `treatingClinicianId`. Shared helper behind read, update, sign, cosign
  and amend — one edit covers all five.
- `src/notes/service.ts:~185` `listProgressNotes()` scopes its SQL to
  `authorId: { in: [self, ...supervisees] }`.

Until those two land, `authorSupervisorOrTreating` is a policy no call site can
satisfy. `clients/repository.ts:250` already passes `clinicianId` and needs
nothing.

## What just landed (Phase 2, committed and pushed — d3bb1ff)

Two migrations. `20260910161613_progress_note_abandoned` holds one line, the
enum value, alone: Postgres permits `ALTER TYPE … ADD VALUE` in a transaction
but forbids *using* the value in the same one, and Prisma wraps every migration
in one. Anything that names `abandoned` has to be in a later migration.

1. **`Departure` + `DepartureAssignment`** (P0-1), with five rules Prisma has no
   syntax for: `departure_one_open_per_user` (partial unique on `planned`, so
   the P2 returning clinician stays possible), `departure_last_day_after_notice`,
   `departure_execution_is_complete`, `departure_transfer_has_a_receiver`
   (biconditional), `departure_destination_only_when_referred_out`
   (one-directional, like the inquiry sibling).
2. **`ProgressNoteStatus.abandoned`** (P0-4b) + `abandonedByDepartureId`, a
   CHECK pairing them, and two new clauses in `progress_note_content_frozen`:
   only from `draft`, and terminal.
3. **`ProcessNote.unreachableSince`** (P0-10),
   `process_note_delete_only_after_departure`, and `runProcessNotePurge` in
   `src/staff/departure.ts`. `PracticeSettings.processNoteAfterDepartureDays`
   ships at 2555 (seven years).
4. **`npm run purge:run`** — one schedule for both retention sweeps. Settles the
   PRD's open question as D-16.

WRITEUP §30, four decisions logged (D-16 … D-19).

## Two things that bit, so they do not bite again

1. **Referential cascade is an AFTER action on the parent.** The amendment
   trigger's hole was first written as `EXISTS (… unreachableSince IS NOT NULL)`
   and failed, because by the time the child's trigger runs the process note is
   already deleted. It is now `NOT EXISTS (… unreachableSince IS NULL)` — the
   absence of a *reachable* parent — which is true in both orders.
2. **Adding an enum value is a one-line diff with a wide blast radius.** Three
   places accepted `abandoned` silently and all three now refuse or label it:
   `coSignProgressNote`, `amendProgressNote`, and both note badges, which
   otherwise fell through to "Co-signed". No type error anywhere. Assume the
   same of any future status.

## Gate

**Green at this commit.** Unit **2884/2884** (28 files), typecheck clean. No
lint script. e2e **not run** — the two badge branches are unreachable until
something sets `abandoned`, and nothing does until Phase 3. Run it before Phase
3 lands, as Phase 1's handoff said and this one repeats.

`npm run db:status` is green on all three local databases.

## Loose threads

1. Public form's throttle read-then-write race. `ponytail:` comment. Still not
   worth a lock at three an hour.
2. A clinician on *leave* (not departing) with their books left open — still no
   mechanism, still P2.
3. Design brief §5b/§5c components with no picture. Still inventory.
4. **Another project's test sweep will make this one look broken.** A `bookable`
   sweep running alongside took load average to 39.8 and every DB test to 1–3s
   (normally sub-second). Check `uptime` and `pg_stat_activity` before reading a
   stack trace.
