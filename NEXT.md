# Next

**Item:** Phase 4 of `prd-intake-inquiry.md` — the UI. `/inquiries` (record a
call, discard with a reason code), the convert form, and the
`inquiryRetentionDays` field on the settings page. Then P1-1, the referral
report.

Phase 3 landed the waitlist XOR, `convertInquiry` and `Client.referralSource`.
The worklist already renders an inquiry entry; nothing else has a screen.

## Model

**Sonnet** (`opusplan` if you want the plan on Opus). Phase 4 is forms, server
actions and rendering against an API whose correctness decisions are already
made and tested — the permission cells, the state machine, the XOR and the
trigger all refuse from underneath. Nothing here has a wrong answer that passes
a green run.

Switch with:

/model sonnet

## Phase 4, concretely

1. **`/inquiries`** — the list (`listInquiries`), a create form
   (`createInquiry`), and discard with a reason-code select
   (`discardInquiry`). Clinicians see the list and the create form and *not*
   the discard control: `may({ action: 'discard', resource: 'inquiry' })`
   decides that, never a role comparison.
2. **The convert form** — `convertInquiry(actor, id, { code, dateOfBirth,
   treatingClinicianId, ... })`. Only front desk can reach it, and that falls
   out of `create` on `client` with no new matrix cell. After it returns,
   **the caller sends the intake packet** with `issueForm` as a separate,
   visible step — `issueForm` refuses a template the client cannot read in
   their language, and that refusal must land in front of the person who
   clicked.
3. **`inquiryRetentionDays` on `/practice`** — with the sentence saying the
   number is a jurisdictional legal question, not an engineering one. The PRD's
   Scope Honesty section is the wording to borrow.
4. **Then P1-1**: referral mix and time-to-conversion on the reports page, and
   the ~40 seeded inquiries (~20 converted, ~15 discarded across the reason
   codes, ~5 open) it is measured against.

## Traps

- **`e2e/denials.spec.ts` exists because these pages returned 500s to the wrong
  role.** Add `/inquiries` to it in the same commit that creates the page, not
  after.
- **Nothing is ever sent to an inquiry (D-05).** No portal link, no form
  request, no outbox row, no "we'll text you the intake form". The absence is
  structural — there is no column — and `inquiry.test.ts` fails the build if a
  relation appears.
- **`Inquiry.note` is front-desk tier free text** and is the design's honest
  weak point. Label the field for scheduling preferences; do not widen it.
- **The seed's client loop PRNG is load-bearing.** `referralSource` is indexed
  by `clientNo`, not drawn — adding a `chance()` there reshuffles every fixture
  downstream and breaks unrelated specs.
- **Dev's database has null `referralSource` on all 97 clients** until someone
  runs `npm run db:seed`. e2e reseeds itself; the referral report will look
  empty on `npm run dev` until you do.

## Gate at this commit

Unit **1935/1935** (was 1922 — +13: conversion, the XOR, the cascade, the
enum/fixture equality, two waitlist worklist rows), typecheck clean.
`scheduling.spec.ts` 8/8 against a fresh production build, because the worklist
page gained a render branch. The new migration is applied to dev, test and e2e.

Migrations **still not on production** — five now, the fifth being
`20260909104500_inquiry_waitlist_and_conversion`. `npm run db:migrate:prod`
when that matters. Production also has no `referralSource` values until it is
reseeded.

## Already answered, do not re-litigate

- `discard` not `delete`; clinicians create but do not discard — WRITEUP §18.
- `Inquiry` separate from `Client`; the trigger over an application check; the
  audit trail pointing at a destroyed row — WRITEUP §19.
- The XOR over two application checks; the one cascade; the pre-generated
  client id; conversion adding no matrix cell; `referralSource` duplicated and
  deliberately unreconciled with the form answer — WRITEUP §20.
- The purge has no scheduler and does not need one. Wire it to the existing
  scheduled path when there is one.
