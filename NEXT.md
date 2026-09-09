# Next

**Item:** P2 — public enquiry form, done. Committed `d6d4870`.

- `/enquire` — bilingual (en/es via `?lang=`), structured fields only, no
  free-text box anywhere. `app/enquire/{page,actions,shell}.tsx` + `done/`.
- New `public` role in `src/auth/permissions.ts`, one cell:
  `inquiry: { create: 'unconditional' }`. `unconditional` is a new rule name,
  deliberately not `always`. Also new: `actingStaffId(actor)`, which is what
  keeps the null-taker decision out of the repository.
- `src/clients/public-inquiry.ts` — kill switch, hourly per-submitter ceiling
  (HMAC key, never the address), honeypot, validation. Order of checks is
  load-bearing and commented.
- Schema: `Inquiry.takenById` nullable + `onDelete: Restrict`; new
  `InquiryThrottle`; `PracticeSettings.publicInquiryEnabled` (default **false**)
  and `publicInquiryPerHour` (default 3). Prisma `Role` enum gains `public`.
  Migrations `20260909190153_public_inquiry_form` and
  `20260909190305_public_actor_role`, applied to dev, test and e2e.
- `CLEARPATH_THROTTLE_SECRET` documented in `.env.example`. Optional; unset
  falls back to a per-process random (fails safe, not weak).
- 33 new unit tests + 7 e2e specs. PRD checkbox ticked, D-07/D-08 added,
  `WRITEUP.md` §25 and 8 decision-log rows.

## Gate at this commit

Unit **2193/2193** (27 files). e2e **38 passed, 1 skipped** (the skipped one is
`screenshots.spec.ts`, gated on `SHOTS=1` — pre-existing). Typecheck clean.
Dev, test and e2e databases all migrated and reseeded.

## What's actually next

Two P2 items left in `prd-intake-inquiry.md`, both still open and undecided:

1. **Clinician queue assignment with capacity signalling** — mid-size; touches
   the state machine and the worklist, no new external surface.
2. **Referral-source detail for `gp` / `referred_out`** — smallest and most
   contained; turns a code into a practice/doctor entity with its own model.

Ask which, if either. No other PRD has open, verified-missing work.

One loose thread worth naming, not urgent: the throttle's read-then-write can
let one extra submission through under a genuine race. It carries a `ponytail:`
comment saying so and naming the fix (atomic increment with the window reset in
SQL). At a limit of three an hour it is not worth a lock.
