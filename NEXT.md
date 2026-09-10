# Next

**Item:** DESIGN — the five-frame demo storyboard, captured. Committed and
pushed as `92d9f06`.

- `e2e/screenshots.spec.ts` walks the brief's storyboard in order and captures
  ten frames: the four that existed (refreshed) plus `note-draft-signing`,
  `cosign-queue`, `note-cosigned`, `audit-log-both`, and the
  `client-record-front-desk` / `client-record-clinician` pair.
- Seed's "demo, guaranteed" block now builds a **draft** note as well as a
  queued one, so frame one is a real signature. Same reasoning as the block's
  existing comment: 85% of notes get signed, so the draft cannot be left to the
  PRNG.
- Queue rows located by `a[href="/notes/<id>"]`, never `.first()` on client
  name. TC-006 has two notes in the queue and `.first()` picked the wrong one —
  same latent hole was in `confidentiality.spec.ts`, now fixed.
- `confidentiality.spec.ts` starts from the signature; test and pictures walk
  the same path.
- WRITEUP §28, seven decision-log rows, README 60-second demo rewritten to five
  frames.

## Gate at this commit

Unit **2455/2455** (27 files). e2e **45 passed, 1 skipped** (`screenshots.spec.ts`,
gated on `SHOTS=1`). Typecheck clean. Recapture with `npm run shots`.

## What's actually next

**All three PRDs remain complete**, and the design brief's §5d storyboard is now
done too. No queued item: ask what to pick up, or propose one.

Candidates raised last session and not taken:

1. **Ponytail audit of the finished repo** — what to delete now every PRD is
   ticked. Opus.
2. **A fourth PRD** — the only option that grows the product rather than
   finishing it. Opus.

Three loose threads, none urgent:

1. Public form's throttle read-then-write can let one extra submission through
   under a genuine race. Carries a `ponytail:` comment. Not worth a lock at
   three an hour.
2. A clinician on leave who left their books open is a wrong signal nobody else
   can correct — D-09's stated cost, not a defect.
3. Design brief §5b/§5c list components and screens with no picture (form
   builder, vacation reschedule work-list, continuity queue, supervision map).
   The storyboard was the one the brief called the argument; the rest are
   inventory, and `docs/screenshots` is not a component library.
