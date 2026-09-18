# PRD: Recoverable Forms — a failed submit that does not delete the answer

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.3 — **decided and built, 2026-09-18** (see Decisions; WRITEUP §56). Raised by the UX/accessibility review. Feature PRD, child of `prd-clearpath-counseling-ops.md`
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

## Decisions

- **2026-09-18, Q1: `useActionState`, with the action returning a code and the
  submitted values.** Shane's call. The form becomes a small client component,
  following the `NoteEditor` pattern. A refusal returns `{ code, values }` rather
  than redirecting, and the fields are refilled from `values` through
  `defaultValue`. The values travel only in the response body, never in a URL or
  a log. Next renders action state into the POST response, so the form is
  expected to keep working with JavaScript off. An e2e with JavaScript disabled
  has to prove that before it is claimed.
- **2026-09-18, Q2: every refusal keeps the values, not just `invalid`.**
  Shane's call. There is one return path, so this is the smaller diff. Someone
  who is rate-limited, or finds the form closed, keeps what they typed and can
  read it back on a phone call.
- **2026-09-18, Q3 (and ticket F2): group booking uses the same
  `useActionState` form.** Shane's call. `bookGroup` returns `{ error, values }`
  and the form refills, ticked attendees included. A review step would not fix
  this: the conflict comes from the database at write time, after any review.
  This also takes the free-text `?error=` message off this page's URL.
- **2026-09-18, Q4: email and phone stay unrequired in the browser, and the
  either/or rule stays on the server.** Shane's call. Now that the values
  survive, a refusal costs one round trip and an alert saying what to fix. An
  `invalid` refusal is thrown before the rate-limit slot is claimed, so it does
  not use up an attempt. A client-side copy of the rule would be a second place
  to keep in step.

## Not in scope

Changing the either-email-or-phone rule itself. That is an intake policy decision
already made in `prd-intake-inquiry.md`.
