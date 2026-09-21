# Next

**Portfolio artifacts (2026-09-21):** `docs/DEMO.md` added — a live-verified
demo script (repo, root). The exec-brief write-up for a non-engineering
reader is published at https://claude.ai/artifact/CK3xxxExfd2gCiG6YM7aMn
("Clearpath in Brief"). LinkedIn drafts from this project's write-up are
still outstanding — see the global CLAUDE.md's "definition of done" for what
that needs. Live deployment: https://clinic.labintelligence.co. Repo (private):
https://github.com/shanelabountyai/clearpath.

**PRD 6 (accessibility conformance) is built through Q4** (2026-09-19).
Q1 (AA target) and Q5 (Shane's VoiceOver pass) were always his; Q2–Q4 are done:

- **Q2**: `design-system.test.ts`'s contrast check is now fully derived from
  `theme.css` — every `--text*` token against every `--surface*` and every
  `-soft` token (4.5:1), `--border-control` and every `--status-*` token
  against every surface (3:1), every semantic color against its own soft fill
  and `--on-solid` against that same fill as solid (4.5:1). `--border-control`
  and `--text-subtle` both needed real darkening — `--border-control` failed
  against `--surface-inset`, which the old test never checked; `--text-subtle`
  failed against several `-soft` backgrounds, caught only once Q3's axe sweep
  ran (see below). `--text-subtle` is now `#69655d` light / `#928f8a` dark.
- **Q4**: the gallery has focus-visible and error specimens (`.option` ring,
  `TextField`'s new `invalid`/`hint` props), and a test enforces both.
  Disabled stays out — nothing uses it yet.
- **Q3**: `e2e/accessibility.spec.ts` runs `@axe-core/playwright` (WCAG 2.2 AA
  tags) against the 3 client-facing pages and 14 staff pages. The repo's
  first `.github/workflows/ci.yml` runs typecheck, unit tests and the full
  e2e sweep against a Postgres service, on a production build — **verified
  with a real run on GitHub Actions, green in 5m52s** (run 35459362463).
  No lint step: the repo has no ESLint config or `lint` script, and a fake
  step would paper over that rather than run anything — add one deliberately
  in its own change if it's ever wanted.

The first axe sweep found three real, pre-existing violations, all fixed:
`--text-subtle` under 4.5:1 on `-soft` backgrounds (see Q2 above — one of
these was a pair the Q2 commit had wrongly called "never renders," caught by
axe on a page a hand grep missed), a worklists link inside prose with no
non-color cue (now permanently underlined, not hover-only), and an unlabeled
`<select>` on forms admin (now has `aria-label`).

**Next item: Q5 — Shane does one VoiceOver pass (Safari, macOS) on the
intake form, the screener, and the enquiry form.** Findings go in WRITEUP;
any defect gets fixed or ticketed. That's the last piece of PRD 6.

**Known gaps, unchanged since the last handoff:** e2e SQL that converts
`startAt` to practice time disagrees with the app by the psql session's
timezone (America/Chicago on this laptop) — check before any spec picks a
slot by SQL time. PRD 2 does not catch the browser's back button inside the
app. The amendment forms still lose their text on a failed save (§54).
`screenshots.spec.ts` was edited for the dialog but only runs under
`SHOTS=1`.

**Gate state at handoff:** full unit sweep 35 files / 3243 tests, EXIT=0.
Full local e2e sweep (all 15 spec files): 86 passed, 1 skipped (shots,
SHOTS-gated), EXIT=0. `tsc --noEmit` clean. GitHub Actions CI: green.

**A resource-contention note, not a code issue:** two local sweep attempts
died mid-run (SIGKILL, no jetsam log) while three *other* Claude sessions on
this machine were running their own full build/test sweeps concurrently
(Restaurant ordering, apptbasedservice/bookable, and a third `build:test` +
`start:test`). Third attempt, after they'd eased off, ran clean in ~2
minutes. Nothing to fix here — just don't be surprised by a SIGKILL with no
jetsam entry if several projects' sweeps overlap; retry once they clear.
