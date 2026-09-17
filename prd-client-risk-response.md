# PRD: Client-Facing Risk Response — what the person sees after they disclose

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.1 — **stub, 2026-09-17.** Raised by the UX/accessibility review. Open questions below are unanswered; this is not yet a buildable spec. **Start the conversation before the build — this one needs a clinician.** Feature PRD, child of `prd-clearpath-counseling-ops.md`
**Learning objective:** the difference between routing a signal correctly and answering the person who sent it — the alert side of this is already right, and the person is still looking at a blank thank-you

---

## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. See the banner in `README.md`.

**What to say to a person who has just disclosed risk is clinical work, not
interaction design.** This PRD must not invent the copy. It exists to get the
question in front of someone qualified to answer it, and to record what they say.

## Problem Statement

`submitForm` computes `needsReview` and its reasons, and fires a private alert to
the treating clinician (`src/forms/service.ts:234-259`). That part is correct and
respects hard rule 9.

The result is then thrown away. `app/f/[token]/actions.ts:34` redirects
unconditionally to the done page, and `app/f/[token]/done/page.tsx` renders fixed
strings and takes no result. A client who has just answered a suicide-risk item
sees the identical message as someone whose answers were unremarkable:

> Thank you — that has been sent. There is nothing else you need to do.

Worse: crisis-line copy already exists in this codebase (`enquireUrgent` — "call
911 or go to your nearest emergency room"), but only on the **enquiry** form,
which by design never touches clinical content. It is absent from the one flow
where a client is most likely to disclose acute risk.

This is the only finding in the review with a duty-of-care dimension rather than
a usability one.

## Open questions — the product owner must answer these before this is buildable

1. **Can the done page say anything different for a flagged submission without
   telling the client they were flagged?** Telling them may itself be harmful, or
   premature before a clinician has reviewed the answers.
2. **Or is a general safety footer appropriate on every screener completion,
   flagged or not?** Crisis line, plus "if this is urgent, call —". This sidesteps
   the disclosure problem entirely, treats every client the same, and is probably
   the strongest candidate. It is also the cheapest to build.
3. **Is a boolean `needsReview` acceptable to pass out of the submission
   transaction at all?** It is not PHI. But the project's instinct elsewhere is
   that no clinical signal leaves the transaction, and that instinct deserves a
   deliberate exception rather than a quiet one.
4. **Does the clinician's response-time commitment change what the client is
   told?** "Someone will follow up today" is a better message than the current
   line — and is only safe to show if operations can keep it. Do not make the
   promise before checking.
5. **Does this copy need to exist in both languages?** The done page already
   reads the client's language from the row. Whatever is written here must be
   written twice, and the Spanish is clinical copy too, not a translation task.

## Not in scope

Changing where the alert goes. Treating clinician only, never a shared inbox
(hard rule 9). Nothing in this PRD may widen that.
