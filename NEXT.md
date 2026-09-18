# Next

**Pick up the remaining P1 tickets from the UX/accessibility review.** B and C
landed 2026-09-18 (WRITEUP §51). The full grouping of the other tickets is in the
Claude Doc "Clearpath — UX & Accessibility Review", 2026-09-17. Read it there;
this file does not repeat it. Before building from a `prd-*.md` stub, read the
stub: its open questions have not been answered.

## Before anything else: thirty seconds in a browser

Three changes are CSS or markup that no unit test renders. None of them has
been looked at in either theme:

- **Contrast tokens** (commit 23593ea): check `/clients` in light and dark.
- **Screener focus ring** (`.option:has(:focus-visible)`): open a form link at
  `/f/<token>` and press Tab through a scale question. Each option should show
  the accent ring.
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
3. **A flagged screener shows the client a generic thank-you** — the crisis-line
   copy exists, but only on the enquiry form. → `prd-client-risk-response.md`
4. **Intake form deletes everything on a failed submit** — full-page redirect,
   `app/enquire/actions.ts:56`. → `prd-recoverable-forms.md`
5. **Sign / execute departure fire on one unconfirmed click.** Until 2026-09-18
   the staff app had no client component. `src/ui/nav-list.tsx` is now the
   first, and it is the pattern for adding one: the server decides
   permissions and passes plain props across. → `prd-action-confirmation.md`

Plus `prd-accessibility-conformance.md` — do we commit to AA, and does a check
join CI. Decide early, build last.

## Suggested next item

The next P1 ticket in the doc's grouping that needs no product decision. If
none is left, move to `prd-accessibility-conformance.md`: it is the P0-adjacent
decision cheapest to make early, and B and C now give it concrete evidence.

## Open question waiting on a person

Left as a comment in the doc: does the risk-response PRD go with a general
safety footer on every screener completion, or a message that differs for
flagged clients? The general footer sidesteps the disclosure problem and is
cheaper; it is the recommendation but not the decision.

## Gate state at handoff

`npm test` passed under the `set -m` job-control launch: 33 files, 3232 tests
(3227 before plus 5 new), EXIT=0. `tsc --noEmit` is clean. The EXIT=137 oddity
from 2026-09-17 did not recur.
