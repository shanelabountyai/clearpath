# Next

**PRD 4 (recoverable forms) is decided and built** (2026-09-18), and ticket F2
went with it. The intake and group-booking forms are `useActionState` client
components. A refusal returns `{ id, code|error, values }`, and the form is
keyed on `id` so its selects refill too. The values travel in the response body,
never a URL, and an e2e with JavaScript off proves the public form still works.
WRITEUP §56. With that, all five P0s are built.

**The review's P1 tickets are built** (2026-09-18): D1–D3, E1–E2, F3, F4's
`?error=` half and G1. WRITEUP §57. No ticket needed a product decision.
Refusals now carry a `Conflict` code in the URL, never its message. A guard in
`no-phi-in-urls.test.ts` enforces that.

**Next item: PRD 6, `prd-accessibility-conformance.md`.** Do we commit to AA,
and does a check join CI? The review says decide first and build last, and
every other item is now built. Read the PRD, then ask one question at a time.

**Known gaps:** e2e SQL that converts `startAt` to practice time disagrees with
the app by the psql session's timezone (America/Chicago on this laptop). The
cause is unknown, so check it before any spec picks a slot by SQL time.
PRD 2 does not catch the browser's
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
- **P1 markup** (§57): the booking time and repeat pills (✓, bold, a focus ring
  when you Tab), the "Missing" lines on `/forms` for a blank translation, the
  From/To labels on `/reports`, and the Older events link on `/audit`.
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

`npm test` passed under the `set -m` job-control launch: 35 files, 3242 tests,
EXIT=0. drafts, scheduling and confirm specs: 13 passed on a production build. `tsc --noEmit` is clean. `enquire.spec.ts` and `scheduling.spec.ts`
ran 20 passed on a production build. The full e2e sweep has not run since
ticket C.
