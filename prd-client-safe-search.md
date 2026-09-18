# PRD: Client-Safe Search — finding a person without naming them in the URL

**Sample business:** "Stillwater Counseling" (as in the parent PRD)
**Status:** v0.3 — **decided and built, 2026-09-18.** All four open questions answered (see Decisions). Raised by the UX/accessibility review. Feature PRD, child of `prd-clearpath-counseling-ops.md`
**Learning objective:** what hard rule 3 costs when the thing it forbids is also the most natural way to build a search box — and why the two hard rules with build-time tests held while this one drifted

---

## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. See the banner in `README.md`.

## Problem Statement

`app/(staff)/clients/page.tsx:22-28` renders a plain `<form>` with no `method`, so
it submits by GET. The input is named `q` and its placeholder is "Name or code".
Typing a client's name produces `/clients?q=Jane+Doe`.

That name is then in browser history, in the server access log, in the referrer
header of anything linked from that page, and in the URL bar of a machine at a
front desk that members of the public stand in front of.

This is hard rule 3 — *no PHI anywhere but the record itself, never in a URL* —
broken in the most visible place the product has.

**Scope is narrow, and that is the good news.** Every other `searchParams` shape
in the staff app was checked: appointment ids, client ids, actor ids, dates,
status codes, cursor tokens. All ids or codes. The exposure is two free-text
inputs:

1. the client name search above;
2. `app/(staff)/audit/page.tsx:79-80`, whose reason filter is unvalidated free
   text reflected into `?reason=` and into the CSV export link. Note that
   `AuditRow` already refuses to *link* a non-code reason for exactly this
   hazard — the filter reopens the door the row closed.

**Related, same root:** `app/(staff)/book/actions.ts:34-35,63` writes booking
conflict *messages* rather than codes into `?error=`, rendered verbatim. Today's
messages name no client. The mechanism is a standing hazard the first time one does.

## Open questions — the product owner must answer these before this is buildable

1. **Does name search survive at all?** Client codes are already URL-safe and
   staff may well know them. Ask the front desk how they actually look someone
   up before assuming the answer is "keep names".
2. **If names stay, the term has to live in browser memory rather than the URL.**
   That makes a filtered client list no longer bookmarkable or shareable. Is
   anyone relying on that today?
3. **What about the audit reason filter?** Same defect, different user — an
   auditor, who may have a real need for a shareable filtered view. The answer
   here may differ from the answer for client search.
4. **Should hard rule 3 get a build-time test?** Rules 1 and 2 have source-grepping
   tests (`permissions.test.ts`, `notes/service.test.ts`) and did not drift. Rule 3
   has none and did. What would the test assert — that no `searchParams` type in
   `app/` declares a free-text field? That is crude but would have caught this.

## Decisions

- **2026-09-18, Q1: name search stays.** Shane's call. A front-desk lookup
  starts with a caller saying their name. Code-only search would push staff
  to scan the whole list by eye on a screen the public can see, which exposes
  more than the defect it fixes. The term has to leave the URL; Q2 decides how.
- **2026-09-18, Q2: filter in the browser.** Shane's call. `/clients` already
  sends every row the actor may read, with no pagination, so a client component
  filters the rendered table. The term never reaches the network, the server
  log, browser history or a referrer, and no endpoint is added. A filtered list
  is no longer bookmarkable. **Ceiling:** if the list is ever paginated, search
  has to move to the server, and it goes in a POST body, never a URL.
- **2026-09-18, Q3: the audit reason filter accepts codes only, still by GET.**
  Shane's call. The server drops a `?reason=` that fails `AUDIT_CODE`, the same
  test `AuditRow` applies before it links a reason. Auditors keep filtered views
  they can share, and the CSV link, and free text is never reflected back.
- **2026-09-18, Q4: hard rule 3 gets a build-time test that allowlists URL
  keys.** Shane's call. A test reads every `searchParams` type in `app/` and
  fails on any key not in an approved list. It fails closed: a new free-text
  key breaks the build until someone approves the name. **Known gap:** it checks
  key names, not values. The booking `?error=` messages are an approved key
  carrying free text, and they stay a standing hazard outside this PRD.

## Not in scope

Changing what staff can search. This is about where the search term travels,
not about who may find whom — that stays in `src/auth/permissions.ts`.
