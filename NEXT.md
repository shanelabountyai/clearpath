# Next

**Pick up the UX/accessibility review's P1 tickets.** The full review is a
Claude Doc — "Clearpath — UX & Accessibility Review", 2026-09-17 — and the
decisions it surfaced are six new `prd-*.md` stubs in this directory. Read the
stub before building anything from it; each one's open questions are genuinely
unanswered, and two of them need a clinician rather than an engineer.

## What landed 2026-09-16/17 (commit 23593ea)

The review read all 40 UI files in three slices (public/client surfaces, staff
lists, staff detail pages) against WCAG 2.2 AA and this project's hard rules.
5 P0s, 15 P1s. Only the one finding needing no product decision was built:

- **Contrast tokens.** `--text-subtle` was 3.52:1 light / 3.77:1 on dark cards;
  `--tier-operational` was 4.34:1 on its own soft background. Now >= 4.60:1
  against every surface, hue preserved. **Not yet eyeballed in a browser** —
  the change is arithmetic and tested, but nobody has looked at a real page in
  either theme. Thirty seconds on `/clients` before trusting it aesthetically.
- **A contrast assertion in `design-system.test.ts`**, verified against the old
  values before being trusted (fails at exactly 3.52:1, passes after).
- **`.claude/agents/ux-a11y-reviewer.md`** — the reviewer agent. Note it was
  written mid-session and the registry only loads at session start, so the
  three review passes ran as `general-purpose` with the brief inlined. It
  should register normally now; if a future session wants another pass, use it
  rather than re-inlining.

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
5. **Sign / execute departure fire on one unconfirmed click** — and the staff
   app has no client component anywhere, so there is nowhere to put a confirm
   step. Architectural. → `prd-action-confirmation.md`

Plus `prd-accessibility-conformance.md` — do we commit to AA, and does a check
join CI. Decide early, build last.

## Suggested next item

**The P1 batch, tickets B and C** (doc has the full grouping). B is the staff
shell: no skip link, no `aria-current`, scroll containers unreachable by
keyboard. C is the clinical screener: required state hidden from screen
readers, invisible focus on every answer option, and a validation error that
never says which question — that last one is plumbing data the server already
computes, not new capability. Highest-stakes surface in the product.

## Open question waiting on a person

Left as a comment in the doc: does the risk-response PRD go with a general
safety footer on every screener completion, or a message that differs for
flagged clients? The general footer sidesteps the disclosure problem and is
cheaper; it is the recommendation but not the decision.

## Gate state at handoff

`npm test` green — 32 files, 3227 tests, EXIT=0, 99.8s under job control.
`tsc --noEmit` clean. Committed and pushed (`23593ea`).

One oddity worth knowing: a first run of `npm test` launched directly died at
`EXIT=137` partway through, with 61% memory available, `vm.memory_pressure` 0,
and no JetsamEvent within three hours — so not the OS. It did not reproduce
under the documented `set -m` job-control launch. If it recurs, that pattern is
the workaround and the cause is still unknown.
