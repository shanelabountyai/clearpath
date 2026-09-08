# Next

**Item:** Phase 4 of `prd-intake-inquiry.md` is done, including P1-1. Pick the
next item off the PRD backlog — or, if the intake PRD is finished, the next
PRD. Check `prd-intake-inquiry.md` for what is left below P1-1.

## Model

Depends on the item. Rule of thumb from the last two sessions held: **Sonnet**
for anything that is forms, actions and rendering over an API whose correctness
decisions are already tested; **Opus** the moment a new permission cell, a new
state transition, or a new database constraint is on the table.

## What Phase 4 landed

- `/inquiries` — list with a status filter, a create form, discard with a
  reason-code select, and the convert form. Both controls come from `may()`;
  conversion is gated by `create` on `client` and added **no new matrix cell**.
- The convert form sends the intake packet as a second, visible act. Both
  outcomes come back to `/inquiries` — `issueForm`'s language refusal reaches
  the person who clicked, saying the client exists and the packet is still owed.
- `inquiryRetentionDays` on `/practice`, with the jurisdictional-question note.
- `referralReport` in `src/reports/intake.ts`, on the reports page as two cards.
- 40 seeded enquiries: 20 converted onto TC-041..TC-060, 15 discarded across all
  seven reason codes, 5 open.
- `e2e/intake.spec.ts` (2 specs), WRITEUP §21 and 8 decisions-log rows.

## Traps this session hit

- **The P0-1 lint in `inquiry.test.ts` greps source as text, comments included.**
  A comment in `src/reports/intake.ts` explaining why an appointment join was
  absent failed the build by naming the model. The check is right; do not soften
  it. Write around it.
- **`referralReport` guards on `attendance_history`, not `read: inquiry`** —
  same as every other aggregate on that page. What leaves it is counts.
- **The seed's inquiry block uses no `rand()` at all**, index arithmetic only.
  Adding a `chance()` there reshuffles nothing today but breaks the report's
  reproducibility, which is what makes it eyeballable.
- **`daysToConversion` works because clients are seeded at `now()`** and the
  enquiries are backdated. If client `createdAt` ever gets backdated too, that
  number needs revisiting.

## Gate at this commit

Unit **1941/1941** (was 1935 — +6 referral report), typecheck clean, e2e
**28/28** against a fresh production build with a reseeded fixture. Pushed.

Migrations **still not on production** — five, unchanged this session; Phase 4
added no migration. `npm run db:migrate:prod` when that matters. Production also
still has no `referralSource` values and no enquiries until it is reseeded, so
the referral report is empty there.

## Already answered, do not re-litigate

- Everything in WRITEUP §18–§20, plus §21: conversion adding no `convert`
  action; the control absent rather than disabled; the send being a second act;
  the report counting calls not clients; the rate dividing by open calls; the
  median over the mean; `null` over zero; why "call to first session" is not
  answered; the retention number being a legal question.
