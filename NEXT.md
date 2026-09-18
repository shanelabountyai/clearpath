# Next

**PRD 4 (recoverable forms) is decided and built** (2026-09-18), and ticket F2
went with it. The intake and group-booking forms are `useActionState` client
components. A refusal returns `{ id, code|error, values }`, and the form is
keyed on `id` so its selects refill too. The values travel in the response body,
never a URL, and an e2e with JavaScript off proves the public form still works.
WRITEUP §56. With that, all five P0s are built.

**Next item: the remaining P1 tickets** from the review (a Claude Doc titled
"Clearpath — UX & Accessibility Review"): D1–D3, E1–E2, F3, F4's `?error=`
half, and G1. The audit-reason half of F4 was done in PRD 1. Read each ticket
in the doc before assuming it needs no decision.

Shane wants decisions **one at a time**: one question, options, the
recommendation first. Record each answer in the PRD and the WRITEUP decisions
log before asking the next.

**Known gaps:** e2e SQL that converts `startAt` to practice time disagrees with
the app by the psql session's timezone (America/Chicago on this laptop). The
cause is unknown, so check it before any spec picks a slot by SQL time.
Individual booking's `?error=` still carries messages, not codes
(`app/(staff)/book/actions.ts:34-35,63`). PRD 2 does not catch the browser's
back button inside the app, and the amendment forms still lose their text on a
failed save (§54). `screenshots.spec.ts` was edited for the dialog but only
runs under `SHOTS=1`, so the edit is unverified.

**e2e:** the seven specs PRD 5 touched ran 20 passed, 1 skipped (shots). The
full sweep has not run since ticket C. Let CI run it, or run it once before
trusting the rest.

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
- **Confirm dialog** (PRD 5): sign a note, or record a leave, in both themes.
  Check the backdrop, that focus lands on Go back, and that Esc closes it.
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

Each one was blocked on a product decision. All five are built:

1. ~~**Client name in the URL**~~ — built 2026-09-18. → `prd-client-safe-search.md`
2. ~~**A progress note can vanish**~~ — built 2026-09-18. → `prd-note-draft-protection.md`
3. ~~**A flagged screener shows the client a generic thank-you**~~ — built 2026-09-18. — the crisis-line
   copy exists, but only on the enquiry form. → `prd-client-risk-response.md`
4. ~~**Intake form deletes everything on a failed submit**~~ — built 2026-09-18, with F2. → `prd-recoverable-forms.md`
5. ~~**Sign / execute departure fire on one unconfirmed click.**~~ — built 2026-09-18. Until 2026-09-18
   the staff app had no client component. `src/ui/nav-list.tsx` is now the
   first, and it is the pattern for adding one: the server decides
   permissions and passes plain props across. → `prd-action-confirmation.md`

Plus `prd-accessibility-conformance.md` — do we commit to AA, and does a check
join CI. Decide early, build last.

## Gate state at handoff

`npm test` passed under the `set -m` job-control launch: 35 files, 3240 tests,
EXIT=0. `tsc --noEmit` is clean. `enquire.spec.ts` and `scheduling.spec.ts`
ran 20 passed on a production build. The full e2e sweep has not run since
ticket C.
