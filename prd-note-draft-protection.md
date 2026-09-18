# PRD: Draft Protection — the note that survives the interruption

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.3 — **decided and built, 2026-09-18.** All five open questions answered (see Decisions). Raised by the UX/accessibility review. Feature PRD, child of `prd-clearpath-counseling-ops.md`
**Learning objective:** that "save the user's work" is not a UI convenience in a clinical record system — a draft that persists is a draft that is discoverable, so the safe-feeling answer carries a legal cost that has to be chosen deliberately

---

## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. See the banner in `README.md`.

**Whether an autosaved draft is a discoverable clinical record is a legal and
practice-policy question, not an engineering one.** This PRD must not decide it.
Some practices would rather lose a note than hold a persisted draft of it. That
is a legitimate position and the current behaviour accidentally implements it.

## Problem Statement

A clinician writing a progress note or a private process note has no protection
against losing it. Verified by repository-wide search: zero occurrences of
`beforeunload`, `autosave`, `localStorage` or `useActionState` anywhere outside
the public form runner.

`app/(staff)/notes/[id]/page.tsx:56-83` and
`app/(staff)/process-notes/[id]/page.tsx:55-72` are plain server-action forms
around an uncontrolled `<textarea>`.

Two concrete ways the note dies:

- **Session lapse.** Every save action calls `requireSession()` first, and
  `src/session.ts:59-64` redirects to the person picker when there is no session.
  If the session lapsed while the clinician was typing, the redirect fires before
  the text is ever persisted.
- **Any thrown error.** There is no `error.tsx` at any route in the application
  (verified: none exists). A `Conflict` from a race, or a database hiccup, drops
  the clinician onto the framework's default unstyled error page with the note gone.

The scenario this product is built around — ten minutes between sessions — is
exactly the scenario where a phone call, a closed laptop lid, or a stray
back-navigation costs the whole note.

This is not a WCAG issue. It is data loss on the application's core task.

## Open questions — the product owner must answer these before this is buildable

1. **Autosave on an interval, save on blur, or keep the explicit Save draft
   button and warn before navigating away?** Each feels different to someone
   writing under time pressure. The last is the smallest change.
2. **Is an autosaved draft a discoverable clinical record?** Needs a clinician
   and probably a lawyer. A draft that persists can be subpoenaed. If the answer
   is that the practice does not want persisted drafts, then the fix is a
   navigation warning and nothing else — a much smaller piece of work, and a
   deliberate choice rather than the current accident.
3. **On session lapse mid-edit, extend the session or preserve the text through
   the redirect?** Note the text cannot go in a URL (hard rule 3), so preserving
   it means server-side draft storage — which is question 2 again.
4. **Does a failed save get its own error screen that hands the clinician back
   their unsent text?** This is worth building regardless of the above, and it
   needs the app's first `error.tsx`.
5. **Does a draft save get audit-logged?** Hard rule 4 says every clinical write
   is audit-logged in the same transaction. An autosave firing every thirty
   seconds would flood the audit log. Is an autosave a "write" for rule 4's
   purposes, or is only an explicit save?

## Decisions

- **2026-09-18, Q1+Q2: the app never saves note text the clinician did not
  choose to save.** Shane's call. Both note types already write to the
  database on an explicit Save draft or Save, so a persisted draft is already a
  record, and that is the clinician's decision each time. Nothing is added to
  it: no interval autosave, no save on blur, no browser storage. The fix keeps
  the text on the page instead. A failed save, whether from a thrown error or a
  lapsed session, returns to the form with the text still in the box, and
  leaving the page with unsaved changes asks first. That also answers Q5: an
  explicit save is the only write, and it is audited as it already is.
  **Ceiling:** a closed tab, a crashed browser or a dead laptop still loses
  unsaved text. That is the price of creating no record the clinician did not
  choose.
- **2026-09-18, Q3: nothing to extend.** Default taken, not asked, because it
  follows from Q1. `src/session.ts` is a cookie-based person picker with no
  expiry. A "lapse" means the cookie is gone, or it now names someone else
  after a switch in another tab. The save returns `signed-out` or `denied`, and
  the text stays in the box.
- **2026-09-18, Q4: yes, on the form itself, not on an error screen.** Default
  taken, not asked, because it follows from Q1. The staff `error.tsx` exists
  now, but a thrown save would unmount the form into it. So the save actions
  never throw: they return a code, and the form shows a fixed sentence above
  the text it kept.
- **Found while building:** Close note did not send the textarea, so edits
  since the last Save were lost on every close. It now saves first, as Sign does.

Built as WRITEUP §54.

## Not in scope

Changing who can read a process note. Author-only at every layer stays (hard rule 2).
A draft-recovery mechanism must preserve that — a recovered process-note draft is
readable by its author and nobody else, including whoever operates the recovery.
