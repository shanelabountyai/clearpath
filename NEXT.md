# Next

**Item:** P2 — referral-source detail (which practice, which doctor), done.
Committed and pushed as `a53de40`.

- `Referrer`, one table for both directions. `Inquiry.referrerId` and
  `Inquiry.referredOutToId`, both `Restrict`.
- New resource `referrer`: clinicians `read create` (the `inquiry` shape),
  front desk and admin `read create update`. **`public` holds nothing** — an
  anonymous "my GP sent me" stays a bare code. No `discard` on the resource at
  all; retiring is `active: false`.
- Two database CHECKs (`inquiry_referrer_only_for_gp`,
  `inquiry_referred_out_has_a_reason`). The service *shapes* rather than
  throwing, because the form has no JS to hide the picker.
- Report gains `referrers` and `destinations`. No "Unknown" bucket.
- `Client` deliberately gets no `referrerId` — the converted enquiry is kept.
- Migration `20260910143549_referral_source_detail`, applied to dev, test, e2e.
  Seed: 6 practices, one retired and still pointed at.
- PRD box ticked, D-11/D-12, `WRITEUP.md` §27, 6 decision-log rows.

## Gate at this commit

Unit **2455/2455** (27 files). e2e **45 passed, 1 skipped** (`screenshots.spec.ts`,
gated on `SHOTS=1` — pre-existing). Typecheck clean. Dev, test and e2e databases
migrated and reseeded.

## What's actually next

**`prd-intake-inquiry.md` is complete.** Every P0, P1 and P2 box is ticked.

No other PRD has open, verified-missing work — that was established last
session and nothing since has changed it. So the next session has no queued
item: ask what to pick up, or propose one.

Two loose threads, neither urgent, both carried forward unchanged:

1. The public form's throttle read-then-write can let one extra submission
   through under a genuine race. Carries a `ponytail:` comment naming the fix.
   At three an hour it is not worth a lock.
2. A clinician on leave who left their books open is a wrong signal nobody else
   can correct — D-09's stated cost, not a defect.
