# PRD: Recoverable Forms — a failed submit that does not delete the answer

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.1 — **stub, 2026-09-17.** Raised by the UX/accessibility review. Open questions below are unanswered; this is not yet a buildable spec. Feature PRD, child of `prd-clearpath-counseling-ops.md`
**Learning objective:** that hard rule 3 forecloses the conventional fix — you cannot echo the values back through the URL when the values are a name, an email and a phone number

---

## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. See the banner in `README.md`.

## Problem Statement

Two forms discard everything typed when validation fails.

**The public intake form.** `app/enquire/actions.ts:56` does a full-page
`redirect('/enquire?e=<code>')` on a caught `Conflict`. Because that is a real
navigation, every field is gone — first name, last name, email, phone, clinician
preference, referral source.

This is not a rare path. Only first and last name carry the browser `required`
attribute (`app/enquire/page.tsx:112-116`); email and phone do not. So a person
who fills in their name and forgets both contact fields passes browser
validation, round-trips to the server, and lands back on a blank form reading
*"We still need your name, and either an email address or a phone number"* — with
no memory of what they wrote.

This is the front door of the business, and the failure lands on people who are
already finding it hard to ask for help.

**Group booking.** `app/(staff)/book/group/page.tsx` with
`groups/actions.ts:22-25,44` discards the entire form on a conflict — every ticked
attendee, the topic and the time. Front desk redoes a multi-attendee selection
mid-call.

**Why the obvious fix is blocked.** Echoing values back in the query string is
exactly what hard rule 3 forbids: name, email and phone are the canonical
examples of what must never appear in a URL.

## Open questions — the product owner must answer these before this is buildable

1. **Do these pages become interactive client components holding their own
   state?** That is the conventional answer. It means the public intake form no
   longer works with JavaScript disabled — a real consideration for a public
   health-adjacent surface, and one worth deciding rather than absorbing.
2. **Should refusals be treated differently by kind?** Three exist:
   - `closed` and `too_many` are never the person's fault and expect no retry;
   - `invalid` is the one that actually loses live, correctable work.
   Only the third strictly needs state preserved. Treating them alike is simpler;
   treating them differently is smaller.
3. **Does group booking need the same treatment, or does a review-before-submit
   step solve it more cheaply?** A review step would also serve the confirmation
   work in `prd-action-confirmation.md` — worth checking whether one mechanism
   covers both before building two.
4. **Should email or phone become browser-`required`?** Currently neither is, which
   is what lets a person reach the server-side either/or rule at all. Making the
   pair required in the browser is not expressible in plain HTML, so this is part
   of question 1.

## Not in scope

Changing the either-email-or-phone rule itself. That is an intake policy decision
already made in `prd-intake-inquiry.md`.
