# PRD: Accessibility Conformance — the target, and the test that holds it

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.1 — **stub, 2026-09-17.** Raised by the UX/accessibility review. Open questions below are unanswered; this is not yet a buildable spec. **Decide early, build last.** Feature PRD, child of `prd-clearpath-counseling-ops.md`
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

## Not in scope

Retrofitting every P2 in the review. This PRD sets a floor and a gate; the tail
gets picked up opportunistically by whoever is already in the file.
