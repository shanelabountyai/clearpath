# Next

**Item:** P1-2 is done. Next off `prd-intake-inquiry.md`: **P1-3 — inquiry age
on the worklist** (open enquiries older than N days, beside the continuity
queue). Then P1-4 (purge preview), which finishes the intake PRD.

## Model

**Sonnet** for P1-3: it is a query and a card on a page that already exists,
over a permission (`read: inquiry`, `always`) that is already decided and
tested. Switch back to Opus for P1-4 only if the preview turns out to want a
new read path rather than the purge's own candidate query.

## What P1-2 landed

- `possibleDuplicates(actor, {phone, email})` in `src/clients/repository.ts`,
  plus `caseloadWhere` extracted out of `listClients` and shared by both.
- `recordInquiry` now redirects to `/inquiries?recorded=<id>`; the page draws
  the warning. No new matrix cell.
- 8 unit tests, 1 e2e spec, WRITEUP §22 and 3 decisions-log rows.

## Traps this session hit

- **The check is `may()` then `guarded`, deliberately.** Admin's client read is
  `breakGlass`, so a bare `guarded` writes a denial row for every call they
  record and offers a break-glass prompt over a phone number. Do not "fix" the
  silent return by making it log.
- **An empty result must render nothing.** A "no duplicates" tick would be a
  lie to a clinician whose match sits outside their caseload.
- **`?recorded=` finds the row in the already-loaded list**, so it only works
  because the redirect drops the status filter. Keep that if the redirect moves.
- **Phone matching is exact.** The e2e spec leans on the seed's `555-01NN`
  format; a seed change to phone formatting breaks that spec, correctly.

## Gate at this commit

Unit **1949/1949** (was 1941, +8), typecheck clean, e2e **29/29** against a
fresh production build with a reseeded fixture. Committed as `7386b38`.
**Not yet pushed** — `git push` is the first thing the next session should do.

Migrations **still not on production** — five, unchanged; P1-2 added none.
Production still has no enquiries until reseeded.

## Already answered, do not re-litigate

WRITEUP §22 and its three decisions rows: warning after the record rather than
a gate; code only and nothing stored; caseload scoping reused rather than a new
cell; exact matching as the accepted ceiling.
