# Next

**PRD 3 (client risk response) is decided and built** (2026-09-18). Every
screener done page now shows `enquireUrgent` (practice phone + 911) in the
client's language, flagged or not. `needsReview` never leaves the transaction.
The only thing still pending is a clinician's own wording, and that is one edit in
`src/strings.ts`.

**Next item: PRD 1, client-safe search** (search by name or by code?). Read
`prd-client-safe-search.md`. Then PRD 2 (draft protection) and PRD 5
(confirmation). Tickets D, E, F2 to F4 and G are P1s that were not in the "Now" group.
Read each one in the doc before assuming it needs no decision.

Shane wants decisions **one at a time**: one question, options, the
recommendation first. Record each answer in the PRD and the WRITEUP decisions
log before asking the next.

**e2e note:** ticket C's `role="radiogroup"` change had broken
`scheduling.spec.ts` "the client form", and its token query could pick a
Spanish client. Both are fixed now. That commit's gate never ran e2e, so run the full
sweep (or let CI) before trusting the rest of it.

## Before anything else: thirty seconds in a browser

Five changes are CSS or markup that no unit test renders. None of them has
been looked at in either theme:

- **Contrast tokens** (commit 23593ea): check `/clients` in light and dark.
- **Screener focus ring** (`.option:has(:focus-visible)`): open a form link at
  `/f/<token>` and press Tab through a scale question. Each option should show
  the accent ring.
- **Input borders** (`--border-control`): any staff form, both themes. The
  edges should be visibly darker than before without looking heavy.
- **Error boundary**: harder to trigger by hand. The review's F1 case can no
  longer happen, so it would take a deliberate throw in a page.
- **Skip link**: on any staff page, press Tab once. "Skip to main content" should
  appear top-left, and Enter should land focus in `<main id="main">`.

## What landed 2026-09-18 (tickets B and C)

- `ScrollX` primitive (required `label`, `role="region"`, `tabIndex={0}`)
  replaces all eight bare `scroll-x` divs. A design-system test fails on any new
  bare use of the class; it was checked against the old markup.
- `NavList`, the staff shell's only client component, sets `aria-current`.
  When several links match, the longest wins (`currentHref`, `src/ui/nav.test.ts`).
- `Conflict.fields` carries the validator's template keys (keys only, never
  answers). The screener lists the refused questions by their on-screen
  numbers and marks each one `aria-invalid`.
- Radio groups are `role="radiogroup"` with `aria-required` and the visible
  asterisk. Text, select and textarea inputs have `aria-required`.

## The five P0s, none of them built

All five are blocked on a product decision, which is why all five have a stub:

1. **Client name in the URL** — `/clients?q=Jane+Doe`, `app/(staff)/clients/page.tsx:22-28`.
   Violates hard rule 3. → `prd-client-safe-search.md`
2. **A progress note can vanish** — no autosave, no `beforeunload`, no
   `error.tsx` anywhere in the app. → `prd-note-draft-protection.md`
3. ~~**A flagged screener shows the client a generic thank-you**~~ — built 2026-09-18. — the crisis-line
   copy exists, but only on the enquiry form. → `prd-client-risk-response.md`
4. **Intake form deletes everything on a failed submit** — full-page redirect,
   `app/enquire/actions.ts:56`. → `prd-recoverable-forms.md`
5. **Sign / execute departure fire on one unconfirmed click.** Until 2026-09-18
   the staff app had no client component. `src/ui/nav-list.tsx` is now the
   first, and it is the pattern for adding one: the server decides
   permissions and passes plain props across. → `prd-action-confirmation.md`

Plus `prd-accessibility-conformance.md` — do we commit to AA, and does a check
join CI. Decide early, build last.

## Gate state at handoff

`npm test` passed under the `set -m` job-control launch: 33 files, 3233 tests,
EXIT=0. `tsc --noEmit` is clean. `build:e2e` production build passed, and both
new CSS rules were confirmed in the shipped stylesheet.
