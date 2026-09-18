# PRD: Confirmation and Undo — the click that cannot be taken back

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.3 — **decided and built, 2026-09-18** (see Decisions; WRITEUP §55). Raised by the UX/accessibility review. Feature PRD, child of `prd-clearpath-counseling-ops.md`
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

## Decisions

- **2026-09-18, Q1: a native `<dialog>` behind one client `ConfirmButton`.**
  Shane's call. The PRD's premise has changed since it was written: `NavList`
  and `NoteEditor` are staff client components now, so a confirm step costs one
  component, not an architecture. Clicking the button opens a native `<dialog>`
  that states the consequence. A second, explicit click submits the same server
  action, and the server still makes every permission decision. Esc or Go back
  does nothing. Not `window.confirm`, because its plain text cannot show a
  consequence such as a count of clients, and people learn to click through it.
  Not a server review screen, because that needs route state for every action
  and costs a page load.
  **Ceiling:** the confirm step needs JavaScript. Without it, the button does
  nothing rather than submitting unconfirmed.
- **2026-09-18, Q2: the dialog guards every irreversible, money, or
  many-people action.** Shane's call. That means sign, co-sign, execute
  departure, cancel a group session, cancel with fee, waive fee, and record a
  departure or leave notice. The PRD suggested something lighter for cancel and
  waive. One mechanism is simpler than two, and moving money is not
  low-stakes. Alert acknowledgement and "Called them" are left to Q3: both are
  frequent, and a dialog on a frequent action teaches people to click through
  the dialogs that matter.
- **2026-09-18, Q3: an audited Reopen, not a dialog and not an undo toast.**
  Shane's call. Acknowledged alerts already stay listed under "N
  acknowledged". That list, and a matching list of handled worklist replies,
  gets a Reopen button. Reopen clears the timestamp, and the item goes back in
  the queue. The first click stays one click. Nothing depends on a timer, so
  someone who notices the mistake the next day can still fix it.
- **2026-09-18, Q4: yes, Reopen is its own audited event.** Follows from Q3 and
  hard rule 4, so it was not asked. The audit row records who reopened what,
  by id, in the same transaction as the reopen.
- **2026-09-18, Q5: yes, the selects stop defaulting.** Default taken, not
  asked. The departure and leave notice selects open on a blank "Choose a
  clinician…" option and are `required`, so the browser refuses a submit that
  names nobody. The dialog from Q2 then names the person before anything is
  recorded.

## Not in scope

Making any of these actions genuinely reversible in the data model. Signing
freezes a legal record and should stay frozen; this PRD is about the moment
before the click, not about unwinding it after.
