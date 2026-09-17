# PRD: Confirmation and Undo — the click that cannot be taken back

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.1 — **stub, 2026-09-17.** Raised by the UX/accessibility review. Open questions below are unanswered; this is not yet a buildable spec. **Architectural — decide before more staff pages are built on the current pattern.** Feature PRD, child of `prd-clearpath-counseling-ops.md`
**Learning objective:** that an all-server-components app has no place to put a confirmation step, so "add a confirm dialog" is an architecture decision wearing a UI costume

---

## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. See the banner in `README.md`.

## Problem Statement

Irreversible actions submit the instant the button is clicked. No confirmation,
no review step, no undo.

| Action | Consequence | Where |
| --- | --- | --- |
| Sign a progress note | Freezes the text permanently; it is a legal record | `notes/[id]/page.tsx:73-78` |
| Execute a departure | Private notes become unreachable, the account closes | `departures/[id]/page.tsx:232-242` |
| Cancel a group session | Cancels for every attendee at once | `groups/[id]/page.tsx:37-43` |
| Cancel with fee / waive fee | Moves money | `appointments/[id]/page.tsx:158-206` |
| Acknowledge an alert | No un-acknowledge affordance exists; sits ~8px from the primary link | `alerts/page.tsx:88-93` |
| "Called them" on a worklist | The client's message is explicitly not stored, so a mis-click loses the only trace | `worklists/page.tsx:296-304` |
| Record a departure/leave notice | "Closes their books straight away"; the select defaults to the alphabetically-first person with no blank option | `leave/page.tsx:66`, `departures/page.tsx:64` |

**Why this cannot be patched button by button.** The entire staff application is
server components with plain `<form action={...}>`. Verified by search: the only
client component in the whole app is the public form runner
(`app/f/[token]/FormRunner.tsx`). There is currently no mechanism anywhere in the
staff app to show even a native `window.confirm`. A decision about *how*
confirmation works has to come before any of these can be fixed.

The users are described in the parent PRD as interrupted constantly, working on
shared desks at a busy reception.

## Open questions — the product owner must answer these before this is buildable

1. **Which pattern?**
   - An interactive confirm dialog. What people expect; introduces the first
     client component into the staff app.
   - A second server-rendered "review and confirm" screen before the action runs.
     Keeps the current all-server shape; costs a navigation.
   The second may also solve the group-booking work-loss problem in
   `prd-recoverable-forms.md` — check before building two mechanisms.
2. **Which actions warrant it?** Suggested floor: sign, co-sign, execute
   departure. Cancel and waive are lower-stakes and might take something lighter,
   such as typing a word to confirm.
3. **Confirmation, or an undo window?** For acknowledging an alert, undo is
   probably better than a dialog staff will learn to click through reflexively.
   These are different mechanisms and the answer may differ per action.
4. **If un-acknowledging becomes possible, is it its own audited event?**
   Everything else in this product is audited (hard rule 4). An undo that is not
   would be a hole in the record.
5. **Do the defaulting selects change?** A select that defaults to the
   alphabetically-first clinician, on a form that closes that person's books, is
   a mis-click waiting to happen regardless of what confirmation is added.

## Not in scope

Making any of these actions genuinely reversible in the data model. Signing
freezes a legal record and should stay frozen; this PRD is about the moment
before the click, not about unwinding it after.
