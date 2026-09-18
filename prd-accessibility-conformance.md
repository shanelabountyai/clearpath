# PRD: Accessibility Conformance — the target, and the test that holds it

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.2 — **decided, 2026-09-18; not yet built** (see Decisions). Raised by the UX/accessibility review. Feature PRD, child of `prd-clearpath-counseling-ops.md`
**Learning objective:** the cleanest natural experiment this codebase has produced — two data-protection rules with source-grepping build tests held for the life of the project, and the third, with no test, drifted. The lesson is not about accessibility. It is about which rules get tests

---

## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. See the banner in `README.md`.

**A conformance claim is a legal statement.** Nothing in this PRD lets the project
claim WCAG conformance. It sets an internal target and the checks that support it.

## Problem Statement

The product has no stated accessibility target and no automated check.

`src/ui/design-system.test.ts` greps the source and fails the build on colour
literals, off-scale type, missing dark-theme tokens, and undocumented components.
That test is why none of those things drifted. Nothing equivalent measures
contrast, labelling, or keyboard reachability — and the review found fifteen P1
defects in exactly those three categories.

Two of them are pure token arithmetic the existing test file could have caught:

| Token | Context | Measured | AA needs |
| --- | --- | --- | --- |
| `--text-subtle` | on `--surface`, light | 3.52:1 | 4.5:1 |
| `--text-subtle` | on `--surface-raised`, light | 3.71:1 | 4.5:1 |
| `--text-subtle` | on `--surface`, dark | 4.11:1 | 4.5:1 |
| `--text-subtle` | on `--surface-raised`, dark | 3.77:1 | 4.5:1 |
| `--tier-operational` | on `--tier-operational-soft`, light | 4.34:1 | 4.5:1 |

The same pattern as hard rule 3 in `prd-client-safe-search.md`: the rules with
tests held, the rules without them did not.

## Open questions — the product owner must answer these before this is buildable

1. **Do we commit to WCAG 2.2 AA as the stated internal target?** For a
   healthcare-adjacent product with a public intake surface this is close to
   table stakes, and may be a contractual requirement depending on the practice's
   payers. Committing to it also means the P1 list becomes a definition of done,
   not a wish list.
2. **Does a contrast assertion join `design-system.test.ts`?** Cheap — roughly
   twenty lines beside a test file that already reads `theme.css` — and it would
   have caught both contrast findings before they shipped. What is the assertion:
   every text token against every surface token it is used on?
3. **Does an automated accessibility check join the e2e sweep?** It would catch
   labelling and landmark defects the token test cannot see. Note the project's
   convention that the laptop runs lint, typecheck, unit tests and touched specs
   only, with CI owning the full sweep — so this is a CI decision, not a local one.
4. **Does the design gallery gain specimens for states that have no picture?**
   Disabled, error, focus-visible. Some of these states do not exist anywhere in
   the product yet (there is no disabled `Button` usage in the codebase), so this
   is partly a decision about which states to canonicalise, not documentation work.
   The gallery test already fails on a component with no specimen; it does not
   fail on a component with no *states*.
5. **Is a manual screen-reader pass part of the definition of done for the three
   client-facing flows?** Automated checks do not catch "this is technically
   labelled and still incomprehensible." One session on the intake form and the
   screener would be worth more than further code reading.

## Decisions

- **2026-09-18, Q1: WCAG 2.2 AA is the internal target, for every screen,
  staff and client-facing alike.** Shane's call. It is a target, not a claim.
  Nothing here lets the project state conformance publicly. The review's P1
  list is now a definition of done, not a wish list.
- **2026-09-18, Q2: every text token against every surface token, in both
  themes, at 4.5:1.** Shane's call. The check is derived from `theme.css`, not
  kept by hand, so a new token is covered the day it lands. A pair that never
  renders is fixed or listed as a named exception in the test, with its reason.
  Keeping a list by hand is how the contrast failures shipped.
- **2026-09-18, Q3: an axe-core spec joins the e2e sweep, and this PRD also
  sets up the CI that runs the sweep.** Shane's call, taken over the smaller
  option of leaving CI as a later item. `@axe-core/playwright` runs with the
  WCAG 2.2 AA rule tags against the client-facing pages and the main staff pages.
  A GitHub Actions workflow runs lint, typecheck, unit tests and the full e2e
  sweep against a Postgres service, on a seeded database and a production build.
  That makes the convention that CI owns the full sweep true. Until now the repo
  had no `.github/` directory.
- **2026-09-18, Q4: the gallery gains focus-visible and error specimens, and
  the gallery test enforces them. Disabled does not.** Shane's call. Both states
  already render in the product (focus rings, and `aria-invalid` on refused
  fields). Disabled is not used anywhere, so defining it now would mean
  designing a state nobody sees. It gets a specimen in the same change that
  first renders it.
- **2026-09-18, Q5: one VoiceOver pass (Safari, macOS) on intake, the screener
  and the enquiry form, done by Shane, before this PRD is called done.** Shane's
  call. Automated checks cannot catch a page that is labelled and still
  incomprehensible. The findings are written into WRITEUP, and any defect they
  find is fixed or ticketed. It is a one-time pass, not a gate on every change.

## Not in scope

Retrofitting every P2 in the review. This PRD sets a floor and a gate; the tail
gets picked up opportunistically by whoever is already in the file.
