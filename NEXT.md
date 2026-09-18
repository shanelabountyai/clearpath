# Next

**PRD 2 (note draft protection) is decided and built** (2026-09-18). Nothing is
saved that the clinician did not choose to save. `NoteEditor` keeps the text on
the page through any failed save, and it asks before leaving with unsaved
changes. Close note now saves before closing: it used to drop the unsaved
edits. WRITEUP §54. PRD 1 and PRD 3 were built earlier the same day. PRD 3's
clinician wording is still pending, in `src/strings.ts`.

**Next item: PRD 5, action confirmation.** Read `prd-action-confirmation.md`.
`src/ui/note-editor.tsx` is now the second staff client component and a
working example of the pattern: a server action returns a code, and the client
keeps its state. Tickets D, E, F2 to F4 and G are P1s that were not in the "Now"
group. Read each one in the doc before assuming it needs no decision.

Shane wants decisions **one at a time**: one question, options, the
recommendation first. Record each answer in the PRD and the WRITEUP decisions
log before asking the next.

**Known gaps:** booking's `?error=` still carries messages, not codes
(`app/(staff)/book/actions.ts:34-35,63`). PRD 2 does not catch the browser's
back button inside the app, and the amendment forms still lose their text on a
failed save (§54).

**e2e:** only `confidentiality.spec.ts` and the new `drafts.spec.ts` ran
(7/7). The full sweep has not run since ticket C. Let CI run it, or run it once
before trusting the rest.

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

## The five P0s

Each one was blocked on a product decision, so each has a stub. 1, 2 and 3 are built:

1. ~~**Client name in the URL**~~ — built 2026-09-18. → `prd-client-safe-search.md`
2. ~~**A progress note can vanish**~~ — built 2026-09-18. → `prd-note-draft-protection.md`
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

`npm test` passed under the `set -m` job-control launch: 35 files, 3238 tests,
EXIT=0. `tsc --noEmit` is clean. The e2e production build passed, and
`drafts.spec.ts` plus `confidentiality.spec.ts` ran 7/7.
