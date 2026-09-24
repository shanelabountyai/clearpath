# Next

**Portfolio artifacts (2026-09-21):** `docs/DEMO.md` added — a live-verified
demo script (repo, root). The exec-brief write-up for a non-engineering
reader is published at https://claude.ai/artifact/CK3xxxExfd2gCiG6YM7aMn
("Clearpath in Brief"). LinkedIn drafts are done: the Lab Intelligence
Ledger (https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i) carries 16
Clearpath posts (3 already posted), including 5 mined straight from the
exec-brief's "Five decisions" section — the no-text-box reschedule button,
the no-show fee's four checks, the screener's universal crisis footer, the
departing-clinician alert bug (the hardest-bug pick), and client-side
search — each tagged to a pillar and slotted with no adjacent-pillar
repeat. All three definition-of-done extras (DEMO, exec-brief, LinkedIn)
are now complete. Live deployment: https://clinic.labintelligence.co. Repo
(private): https://github.com/shanelabountyai/clearpath.

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

**Q5 SKIPPED by Shane (2026-09-23) — PRD 6 closed without it; recorded in WRITEUP decisions.** Original ask: Shane does one VoiceOver pass (Safari, macOS) on the
intake form, the screener, and the enquiry form.** Findings go in WRITEUP;
any defect gets fixed or ticketed. That's the last piece of PRD 6.

**Closed 2026-09-23:** the psql timezone mismatch (`PGTZ=America/New_York` in
`e2e/fixtures.ts`), the back button, and the amendment forms (§54 follow-up).
**Also fixed:** the no-JS enquiry refusal — SEC-05's `Referrer-Policy: no-referrer`
made browsers send `Origin: null` on same-origin form POSTs, so Next refused the
Server Action (a real bug for public no-JS users). Now `same-origin`.

**Known gaps, as of the previous handoff (first three now closed):** e2e SQL that converts
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


---

## Security findings — saas-foundation audit (2026-09-23)

Source: `~/Projects/saas foundation/audit/clinic.md` (full scorecard K1–K14 and evidence). Read-only audit; line numbers are as of 2026-09-23 — **re-verify before fixing**. IDs are `SEC-nn` / `OPS-nn` so they cannot collide with this repo's numbering; convert to a native item when picked up.

### Status (2026-09-23)

**SEC-01, SEC-02, SEC-03 are fixed** (banner instead of a nightly reseed for SEC-02; identity cookie left unsigned for SEC-03 — reasons in WRITEUP's decisions table). **Before the next production deploy set `DEMO_ACCESS_PASSWORD` and `CLEARPATH_SESSION_SECRET` in Vercel** — with the first unset the live site answers 503 to everything but the crons, and with the second unset break-glass throws. Both names are in `.env.example` (OPS-04 done for the password). Then verify live: `curl -I https://clinic.labintelligence.co/` gives 401 with `WWW-Authenticate`, and `/api/cron/reminders` without a bearer gives 401 with no `WWW-Authenticate`. Also fixed in passing: `scheduling.spec.ts`'s absence test had rotted (the seed dates the leave from a fixed 2026-09-01), now re-dated from the database's today. **SEC-05 and SEC-06 fixed 2026-09-23; SEC-04 deliberately closed as accepted plaintext (WRITEUP decisions table).** OPS-03 is covered by SEC-02's banner decision; OPS-05 done. Vercel env vars set and live gate verified 2026-09-23 (401 + WWW-Authenticate on `/`, cron 401 without). Q5 skipped. Nothing remains.

### Gaps

| ID | Sev | Finding and exploit | Fix | Acceptance test |
|---|---|---|---|---|
| SEC-01 | HIGH | **Live deployment has no access gate at all.** There is no `middleware.ts`, and `/` returns 200 publicly. The identity picker (`app/(staff)/layout.tsx:115-118`) plus a `switchUser` that accepts any id (`app/actions.ts:9-12`) lets any visitor become admin, supervisor or auditor. Exploit: open the URL, click "practice manager", open break-glass with any 10-character reason, then read client records and progress notes. Or execute a clinician's departure (`src/staff/departure.ts:899` sets `active:false`), which permanently breaks the demo script. | Add the sibling repo's demo gate: `middleware.ts` with HTTP Basic over everything except `/api/cron/*`, a constant-time compare, and **fail closed in production** when `DEMO_ACCESS_PASSWORD` is unset. Copy `countertop-reserve/apps/web/lib/demo-gate.ts`. | Unit tests: `demoChallenge` gives 401 with no or wrong credentials, null with the right one, 401 or 503 in production when unset. Live: `curl -I https://clinic.labintelligence.co/` returns 401 with `WWW-Authenticate`, and `/api/cron/reminders` without a bearer returns 401 (not a Basic challenge). |
| SEC-02 | MED | **Real personal data can enter a public, world-readable database.** `/enquire` stays public by design and collects name, email and phone (`app/enquire/actions.ts:52-66`). The site is branded as a counseling practice ("Stillwater Counseling"), so a real person could enquire about therapy. Their identity, and the fact that they are seeking counseling, is then readable by every visitor who picks front desk. Staff free-text fields (notes, inquiries) work the same way. The data is not truly synthetic once visitors write to it. | Behind SEC-01 this mostly goes away. Also: a banner on `/enquire` saying "Demo, do not enter real details". A nightly reseed of production (a cron running `db:seed` against the demo database) so anything typed is gone within 24 hours. Consider exempting only `/enquire` from the gate so that its data is purged. | e2e: `/enquire` shows the demo disclaimer. Ops: a cron entry exists and a probe inquiry disappears after the reseed. |
| SEC-03 | MED | **Identity cookie is forgeable and not restricted to the picker.** `switchUser` stores the posted `userId` verbatim (`app/actions.ts:10-12`). `currentSession` accepts any active user id, **including `client`-role users** that the picker excludes (`src/session.ts:41-45` vs `:69`). The break-glass state is a plain cookie (`src/session.ts:47-55`), so a hand-set cookie gets break-glass reach **without** the "break-glass opened" audit row that `startBreakGlass` writes (`app/actions.ts:34`). This matters even after a demo gate, because the gate admits everyone who knows the shared password. | In `switchUser`, reject ids not in `switchableUsers()`. Sign both cookies (HMAC with a server secret) or keep break-glass state server-side (a row with the reason and an expiry), and read that in `currentSession`. | Unit test: `switchUser` with a client-role id leaves the cookie unset. `currentSession` with a hand-set, unsigned break-glass cookie returns an actor with no `breakGlass`. |
| SEC-04 | LOW | **Capability tokens are stored in plaintext.** `FormRequest.token` and `PortalLink.token` (`prisma/schema.prisma:666,870`) are compared by equality. A DB read yields working client links, which open forms, draft answers and appointment views. There is also no `Referrer-Policy` on `/f` and `/p`. | Store `sha256(token)` and look up by hash. Add `Referrer-Policy: no-referrer` and `Cache-Control: no-store` headers for `/f/*` and `/p/*`. | Unit test: the stored row contains no substring of the issued token. A header test on `/p/<token>`. |
| SEC-05 | LOW | **No security headers.** No frame-ancestors or X-Frame-Options (staff screens can be framed for clickjacking), no nosniff, no Referrer-Policy. `x-powered-by` is exposed. Verified in `next.config.ts:3-7` and live headers. | `headers()` with XFO DENY / `frame-ancestors 'none'`, nosniff, Referrer-Policy. Set `poweredByHeader: false`. | e2e header assertions on `/`, `/enquire` and `/p/x`. |
| SEC-06 | LOW | **The test-DB guard is a denylist.** It blocks only `neon.tech`, `rds.amazonaws`, `supabase.co` and `.azure.` (`src/db.ts:13`, `prisma.config.ts:17`, which also lacks `.azure.`). Any other remote host (Render, Railway, a raw IP) passes. | Allow `localhost`, `127.0.0.1` and `::1`, and require `CLEARPATH_ALLOW_CLOUD_DB` for everything else. | Unit test: a `postgres://…@db.render.com/x` URL throws without the flag. |

I found no raw-SQL injection sinks or `dangerouslySetInnerHTML` in `app/` or `src/` (tagged `$executeRaw` only). The authorization design is careful. The problem is almost entirely that authentication and gating are absent on a live URL.

### Ops items

| ID | Item | Evidence |
|---|---|---|
| OPS-01 | ✔ `ignoreCommand` present and exact. | `vercel.json` |
| OPS-02 | ✔ Port 3700 in `package.json` dev, start and e2e scripts. | `package.json` |
| OPS-03 | No reseed or reset schedule for the public demo database. Visitor writes (notes, departures, waived fees) are permanent, and some are immutable by trigger. Add a nightly `db:seed:prod`-equivalent, or treat it as a gate prerequisite. | `vercel.json` crons; `package.json` `db:seed:prod` |
| OPS-04 | `.env.example` should add `DEMO_ACCESS_PASSWORD` (after SEC-01) and mention `/api/cron/nonresponse` in the `CRON_SECRET` comment. | `.env.example:17-20` |
| OPS-05 | Playwright uses `reuseExistingServer: !process.env.CI`, which is fine for CI. Locally it can adopt a neighbour's server if port 3700 is taken (CLAUDE.md trap). Consider `false` as the sibling does. | `playwright.config.ts:28` |
