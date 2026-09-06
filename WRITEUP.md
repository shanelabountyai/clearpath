# Clearpath — build notes

Kept as the work happens, not reconstructed afterwards.

## Core learning artifacts

1. **RBAC with sensitivity tiers** — two classes of clinical note with
   different, deliberately asymmetric rules.
2. **Recurring dual-resource scheduling with a conditional resource** — clinician
   + room, except telehealth needs no room.
3. **Scored dynamic forms with risk thresholds** — versioned templates, scoring
   rules that version with them, critical items that alert regardless of total.
4. **Two-tier notes with supervisory co-signature.**
5. **The superbill** — a claim document assembled entirely from records that
   already existed, and honest about the one it cannot supply.
6. **Screener trends** — the feature whose design is mostly refusals.
7. **Group sessions** — a plural booking of a singular appointment, paid for
   with two exclusion constraints instead of a rewrite.
8. **The client portal** — a door sized to what a leaked link would disclose.
9. **Where authentication would attach** — the one feature whose right build
   was not building it.
10. **The confirmation loop and its fee** — an automatic charge, and the four
    things it is not allowed to conclude.
11. **The reply nobody is allowed to read** — an inbound channel whose defining
    property is that nothing said on it is kept.
12. **The carrier, and what "we asked" is allowed to mean** — the fee's
    precondition moves from a message the practice queued to a message a carrier
    says arrived.
13. **The hour a decline gives back** — a cancellation stops being a loss the
    moment somebody waiting can take it.
14. **The cadence a client chose** — a stated preference, and the question about
    time to *answer* that shipping it exposed.
15. **A deny-list in one language** — the privacy rule that protected clients in
    English and nobody else, and what it took to mean it in two.

---

## 1. RBAC with sensitivity tiers

**The problem.** Access in a counseling practice is not a ladder. A supervisor
outranks an associate on the official record — they must co-sign it — and has
*less* access than that associate to the associate's private process notes,
where the answer is never. A practice manager administers the whole business and
cannot read a session note without breaking glass, and cannot read a process note
even then. Any model where "more senior" implies "sees more" gets this wrong.

**The design.** One declarative `MATRIX: role × resource × action → rule`. Cells
absent from the matrix deny. Rules are five named predicates over the actor and
the *relationships* of the thing being touched (`author`, `authorOrSupervisor`,
`supervisorOfAuthor`, `treating`, `breakGlass`); relationships are resolved from
data by the caller, so reassigning an associate's supervisor in the database
immediately reroutes both read access and the co-sign queue with no code change.

Two decisions worth naming:

- **`process_note` and `progress_note` are separate resources, not one resource
  with a sensitivity flag.** A flag invites `if (note.private)` checks scattered
  across call sites; separate resources put the difference in the policy table
  where it is visible and testable. The supervisor's row reads
  `progress_note: { cosign: ... }` next to `process_note: { read: 'author' }` —
  the asymmetry is legible at a glance.
- **`can()` returns a `Decision`, not a boolean.** It carries which rule fired
  and whether the actor was in a break-glass session, because the audit log
  needs both, and denials must be logged as richly as grants. A boolean would
  have forced every call site to re-derive that context.

**Front desk is modelled by resource, not by field.** "Sees the calendar but not
why anyone is there" could be a field-level projection on a client record; it is
instead separate resources (`client` vs `form_submission`, `form_request` vs
`form_submission`, `attendance_history` split out from `client`). Field-level
redaction is a filter you can forget to apply. A missing matrix cell is a 403.

**What it does not do.** No hierarchy, no role inheritance, no per-record ACLs,
no delegation. `associate` and `therapist` share an identical matrix — the
co-signature requirement is a workflow gate in the note state machine, not a
permission — and modelling it as a permission would have been the intuitive
wrong answer.

**Test approach.** All 546 cells are enumerated and asserted, but the expected
policy is hand-written from the PRD rather than read back off the matrix, so the
suite cannot agree with a wrong edit. Each cell is probed three ways: an actor
holding every relationship *and* break-glass, an actor who supervises the author
but wrote nothing, and an actor with no relationship at all. That last probe is
what proves which permissions are unconditional.

---

## 2. Recurring dual-resource scheduling with a conditional resource

**The problem.** A counseling practice runs on standing appointments: the same
client, the same clinician, the same hour, every week, for months. Each instance
needs a clinician *and* a therapy room, reserved together or not at all — except
when it does not, because a telehealth session needs no room and must not be
blocked by a full room map. So: recurrence, two resources, one of them
conditional, and no double-booking of either.

**The design.**

*Booking is decided by Postgres, not by application code.* Two `EXCLUDE USING
gist` constraints — one on `(clinicianId, tstzrange(startAt, endAt))`, one on
`(roomId, …)`, both filtered to non-cancelled rows — make the insert itself the
check. Room selection is then optimistic: pick a candidate, insert, and on a
room collision (`23P01`) try the next room; on a *clinician* collision stop,
because there is no second clinician to fall through to. A read-then-write
availability check cannot be made safe against a concurrent booking of the last
room, and every attempt to make it safe just moves the window. The race suite
puts ten simultaneous bookings against four rooms and asserts exactly four
commit.

*The conditional resource is a database invariant.* A `CHECK` constraint says
in-person requires a room and telehealth forbids one. It is not an application
habit that a future endpoint can forget.

*Recurrence stores local wall time, never a UTC instant plus seven days.* A
standing Tuesday 3pm is 3pm in March and 3pm in November. Patterns hold a
weekday and minutes-from-midnight; each occurrence converts separately through a
two-pass zoned conversion. `src/time.test.ts` asserts the hour either side of
both DST transitions, and the scheduling suite asserts it again through the
database.

**The bug worth writing down.** Idempotency first keyed on the date the
appointment sits on. Every test passed. Then: reschedule an instance from
Tuesday to Thursday, run the horizon again, and the planner sees an unfilled
Tuesday and books over the slot the client just moved out of. The unique index
on the occurrence key caught it — which is the index doing its job and the
planner failing at its own.

The fix was to separate two things the first design had conflated: **the slot in
the series an instance fills** (fixed at creation, recovered from the occurrence
key) and **where the appointment currently is** (whatever a reschedule made it).
Idempotency keys on the first; withdrawal-on-pattern-change looks at the second.

**What it does not do.** No arbitrary RRULE — weekly and biweekly are what a
practice actually books, and a full recurrence grammar would be a week spent on
a case nobody has. No automatic rescheduling around a clinician's absence: that
produces a work-list for a person, because moving somebody's standing hour is a
conversation, not a write.

---

## 3. Scored forms with versioned rules and risk thresholds

**The problem.** Intake, consent and screeners are data, so a practice manager
can revise them without a deploy. But a screener that has been answered is a
clinical record: revising the instrument must not re-score or re-render what
somebody already completed. And a screener can contain a question whose answer
needs a clinician *today*, whatever the total says.

**The design.** A submission binds to a template *version*, and publishing a
revision creates a new row rather than mutating the old one. There is
deliberately no edit-in-place: that is the single operation that would silently
rewrite history. Scoring rules version with the template, so a v1 response is
always scored by v1 rules.

Two independent paths to review:

- **Thresholds** on the total, with the practice's concern line marked `alert`.
- **Critical items**, which flag regardless of total. Somebody can answer every
  other question at zero, score 1, land in the "minimal" band, and still need a
  call. A design where severity is a single number cannot express that, which is
  why the two paths are separate rather than one weighted score.

A flagged submission raises **one alert to one person** — the treating clinician
— in the same transaction as the submission itself. A scored screener that
half-saved is a client who answered a question about self-harm into a void.

**Reason codes, never content.** The scorer emits `critical:item_9`, not the
answer and not the score. Those strings travel to the alert, the review queue
and the audit log, so anything readable in them is effectively published to
every surface that shows a flag. The wording a clinician reads is assembled at
the very edge, in the alerts page, and is never stored or logged.

**Conditional fields resolve by repeated passes**, so a field revealed by
another conditional field disappears when its parent does. A single-pass filter
leaves orphans visible, which is how a form ends up demanding an answer to a
question it is no longer showing. Only visible fields are scored, so a branch
the client opened and then closed cannot inflate a risk score — and the server
rejects an answer to a hidden question outright, because the form is a trust
boundary.

**Retired questions keep their answers.** Rendering a v1 submission against v2
surfaces them as labelled orphans rather than dropping them. A record that
quietly loses answers is worse than one that shows a question the practice has
since retired.

---

## 4. Two-tier notes with supervisory co-signature

**The problem.** Two classes of note with rules that deliberately do not nest.
The supervisor who must countersign an associate's progress note must never read
that associate's process notes. The practice manager who can break glass into a
session note cannot break glass into a process note.

**The design.** Separate resources, separate rules, one signature workflow. A
progress note goes `draft → signed → cosigned`, where the last step exists only
when the author works under supervision. Whether it does is
`requiresCoSignature(role)` in the auth module — not a role comparison in the
notes service, and not a permission. Modelling it as a permission was the
intuitive wrong answer: an associate writes and signs exactly what a therapist
does, which is why the two share an identical matrix row.

**Immutability at two layers.** The service turns the edit affordance into an
amendment once a note is signed; a database trigger refuses a content change
even if the service is bypassed, and refuses a return to draft. Amendments are
append-only by the same trigger function as the audit log, because they are the
correction mechanism and a rewritable correction is not one.

**Process notes filter on `authorId` in SQL as well as passing the permission
check.** That is not belt-and-braces for its own sake: the check protects the
endpoint, and the filter protects every caller written later by somebody who has
not read this file. Tests assert the absence directly — that a process note
never appears in the progress-note list, the co-sign queue, or any other
clinician's list.

**The decision this forced.** Building the client record surfaced an
incoherence. The co-sign queue shows a supervisor the client's name, because you
cannot countersign a note without knowing whose it is — but the matrix as first
written denied that same supervisor the client's record. They could countersign
blind.

Two readings were available. The literal one: the PRD enumerates supervisor
access for `progress_note` and nowhere else, so deny. The one taken: supervision
is clinical responsibility rather than a signature, so a supervisor's reach over
a supervisee's caseload matches the supervisee's — with exactly one exception,
`process_note`, which stays `author`.

The second is better, and not only because it makes the workflow usable. It
makes the asymmetry *sharper*. A supervisor who could see nothing would meet an
ordinary "not your client" wall. A supervisor who can read the record, the fee,
the attendance, the screeners and the progress notes — and who has just
countersigned one — meets a locked panel directly beneath it, for the one thing
that is never theirs. That is the design's whole argument in a single screen.

---

## 5. The superbill

A superbill is the receipt a client hands their own insurer when the practice
does not bill insurance directly. It needs dates of service, a CPT code per
session, the fee paid, and who rendered it.

The interesting part was how little of it was new. `chargeFeeCents` was already
written onto the appointment when the session completed, for the late-cancel
fee logic — which means the fee *at the time of service* was already on the
record, and the export never has to ask what the client's fee is today. A
superbill built from today's fee would quietly misstate a session from six
months ago, and nothing in the document would show it.

The CPT code is derived, not entered. `90791` for an intake, `90834` for a
fifty-minute hour, `90837` for an extended one, `95` and place-of-service `02`
when it was delivered over video. The two ways to get that wrong — upcoding a
short session, or billing an office code for a telehealth one — are both fraud,
and neither should be reachable by a dropdown on an export screen.

Missed sessions are excluded in the pure function rather than the query. A
no-show carries a fee and belongs on the client's *statement*, but no insurer
reimburses one, and a superbill that lists one is a conversation with a payer.

**Two guards, not one.** The document is a fee record and a set of demographics
at the same time, so `buildSuperbill` passes through the matrix twice and logs
both reads. That was not extra ceremony — it made the access question answer
itself. Front desk may produce one, because they already hold both. The
treating clinician may, for their own client. The practice manager may not,
without break-glass, because their demographics access *is* break-glass and
billing is not an exception carved out of it.

**What it deliberately does not do.** There is no diagnosis code, because
Clearpath does not model diagnoses, and a superbill without one is not
claimable. The export says so on itself rather than looking complete and being
rejected at the payer. Inventing an ICD-10 field to fill the hole would have
been the worst available outcome: a document that looks submittable, produced
by software with no clinical vocabulary behind it.

---

## 6. Screener trends, and what a chart claims

Plotting somebody's screener totals over time is four lines of code and the
most ethically loaded surface in the project. Nearly all the design here is
refusal.

**A scoring revision breaks the line.** Rules version with the template — that
was already true, and it is what makes this feature dangerous. Two totals scored
under different versions of an instrument are not two measurements of the same
thing, so the change between them is `null`, not a number. Draw them as a
continuous line and a rules edit renders as clinical movement, in the direction
whoever edited the rules happened to push it. This is the one place where the
versioning work done for P0-6 pays off in a way that was not obvious when it was
built: the trend could not have been made honest without it.

**One instrument per series.** Points group by template key. A depression total
and a sleep total on one axis is a chart that means nothing and looks like it
means something.

**It reports, it does not conclude.** No slope, no projection, no "improving" or
"deteriorating" flag. A number going down is not a person getting better —
it is nine self-reported answers on a Tuesday — and software that says otherwise
gets believed, by clinicians under time pressure and eventually by whoever else
sees the screen.

**It is its own page.** The obvious build was a panel on the client record. It
is a separate route reached by an explicit link, because a longitudinal chart of
somebody's mental state is not something to meet while scrolling for their phone
number. Asking for it is a deliberate act, and it is logged as one.

**Who can see it.** `form_submission`, which no non-clinical role holds at all.
Front desk cannot reach it; neither can the practice manager, and unlike
demographics or progress notes, break-glass does not open it. There is no
emergency that is answered by a chart of somebody's screener history. That
falls out of the existing matrix without a new rule, which is the second time
this project got a hard question answered by a table it had already written.

The query deliberately does not select `answers`. A trend is a list of totals,
and reaching for the responses to draw it would pull content the surface has no
use for.

---

## 7. Group sessions

The requirement reads "one appointment, N clients", and building it that way
would have been the expensive mistake.

An appointment carrying a list of clients means every path that asks "whose
appointment is this?" has to learn to ask "which attendee?" — the progress note,
the fee at completion, the attendance count, the audit row, the client record,
the continuity queue, the superbill. All of those are about a *person*, not
about an hour, and none of them wanted to change.

So the appointment stays singular and the *booking* becomes plural: a group
session is N appointment rows sharing a `groupSessionId`, one per attendee. Six
people, six notes, six fees, six audit rows, and not one existing query touched.
Attendance-level notes — the part the requirement called out as the hard bit —
came for free, because they were never anything other than what the system
already did.

**What it cost was two constraints.** The clinician and room exclusion
constraints see six rows with the same clinician in the same room at the same
time, which is precisely the double-booking they exist to reject. Adding the
group key as a third excluded column fixes it:

```sql
EXCLUDE USING gist (
  "clinicianId" WITH =,
  (COALESCE("groupSessionId", id)) WITH <>,
  tstzrange("startAt", "endAt", '[)') WITH &&
)
```

Two rows now conflict only if they share the resource, overlap in time, *and*
belong to different bookings. The `COALESCE` is the load-bearing part and the
easy thing to get wrong: with a bare `"groupSessionId" WITH <>`, two ordinary
appointments both have NULL there, `NULL <> NULL` is NULL rather than true, and
the constraint silently stops rejecting anything at all. Falling back to the
row's own id gives every non-group row a key unique to itself, so it still
differs from every other row and the original behaviour is exactly preserved.
A constraint that fails open is worse than no constraint, because the tests
that covered it keep passing.

**Leaving a group is moving out of the hour.** Rescheduling an attendee clears
their group key. Keeping it would let two attendees be rescheduled onto the same
new time and double-book the clinician, since co-attendees are deliberately
exempt from the overlap rule — the exemption has to end where the shared hour
does.

**Cancelling the group cancels six appointments, not one event.** Each goes
through the ordinary cancellation, so each attendee is judged against the
late-cancel window on their own. The practice calling off a group and one client
dropping out of it are different events, and the fee logic already knew that.

**On the calendar it is one chip.** Drawn literally, six attendees are six chips
stacked on the same pixels — which is what a double-booking looks like. Front
desk sees one hour with six people in it and opens the roster from there.

The audit door grew one function for this: `guardedAll`, which nests the guard
once per client record so a booking that writes to six records leaves six rows,
each naming its own client, in the same transaction as the appointments.

---

## 8. The client portal

A client gets a link to their own schedule. The design question is not what to
show them — it is what a forwarded link discloses.

Because there is no login, holding the link *is* the authentication, which is
exactly as strong as the email it arrived in. That is not a reason to refuse to
build it; the form door already made this trade and made it well. It is a reason
to size what is behind it to what you would accept leaking. So the portal shows
when you are coming in, with whom, and whether it is video or a room. Not a
note, not a score, not a fee, not a form, not their record, and not the
appointment *type* — "intake" versus "extended" is a clinical shape, and it is
on the messaging deny-list for the same reason it is absent here.

**The reschedule request carries a reason code, not a message.** This is the
decision I would defend hardest. A free-text box on a client-facing page is a
channel by which a client can write clinical content — "I can't come, the panic
attacks are back" — to the one desk in the practice that must never see it.
Nothing in the code would be wrong; the front-desk work list would faithfully
display exactly what the client typed. So there is no box. Four codes, and front
desk phones them. The conversation that needs to happen is not this system's to
hold, and building somewhere to put it would have quietly made front desk a
clinical surface.

**It requests; it never books.** Same rule as the waitlist, and the same reason:
a client silently moving their own session means nobody notices the client who
moves it every week, and that pattern is clinical information the practice needs
to see.

**A request is idempotent while it is open.** Pressing the button twice is one
request, not two, because the second one is a person who is not sure the first
worked — not new information.

**The token names nothing.** Twenty-four random bytes, no client id, no name, no
readable structure. An unknown token and another client's appointment id both
produce the same not-found, so the door cannot be used to learn whether somebody
is a client here.

Opening it is audit-logged with the client as the actor and `token` as the rule,
exactly like a form submission. The `client` role that P0-1 put in the matrix
"empty on purpose, so a submission has an honest actor" now has a second use it
was not built for, which is usually the sign a boundary was drawn in the right
place.

### The door gains the one destructive thing it can do

The confirmation feature needed a place for a client to answer "am I coming",
and the honest options were a `YES` texted back to a short code or a tap on a
link. The keyword reply is the one the ask described and it is the worse
product: a message that *demands* a reply is more conspicuous on a lock screen
than one that does not, and conspicuousness is not vocabulary — the deny-list
can keep the words neutral and cannot make a compulsory answer discreet. It also
opens an inbound channel, and a client can reply to an inbound channel with
anything, including the most acute thing they have ever written, to a number
front desk monitors. So the response is a tap, and it lands on the door that
already existed.

**No second token type.** A per-appointment token would be a second expiry
policy, a second revocation story, a second audit rule and a second thing to get
wrong. The reminder carries the client's live `PortalLink`, minted once if they
have none — not one per stage, and not one per week.

**A decline cancels; a reschedule request still only asks.** These look
inconsistent and are not. The request *creates* a commitment, and the rule there
is that a person should see one being made. A decline *destroys* one, and an
hour the client has said they will not attend has to free the room or the whole
loop is theatre. The safety rail is that the decline goes through the same
`cancelAppointment` front desk uses, so `classifyCancellation` decides late or
advance from the clock and the practice's existing late-cancel fee applies —
this feature adds no money logic to the decline path at all.

**Inside the 24-hour window, the fee is a thing the client is told.** The first
tap changes nothing: the server decides from the clock whether a charge would
apply and answers with an interstitial naming it in dollars, and the
cancellation happens only on the second tap. Outside the window there is nothing
to disclose, so there is nothing to ask, and the decline is one tap. The two
paths are the same code with the disclosure in front of one of them.

**The capability is stated in `permissions.ts`, not assumed by the door.** The
`client` role stopped being empty. It has exactly one cell — `appointment:
update`, under a `token` rule that requires the row to be the token holder's —
because "what can a forwarded link do" should be answerable from the file that
is the policy, rather than from three functions in `portal/service.ts`. Reading
behind the link and asking for a different time stay outside the matrix; they
change nothing. Confirming and declining change something, so they are written
down.

**Confirming is idempotent, and it is not `status`.** A second tap is the same
confirmation, not a second one — one audit row, not two — for the same reason
the open reschedule request is. And it writes `confirmation`, never
`status: 'confirmed'`: a client saying yes is a communication fact, and a
front-desk check-in is an attendance fact. That separation is the whole feature
(see the decisions log), and the door is the surface where it would have been
easiest to quietly collapse.

**The token is re-rolled until it is discreet.** Putting a link in a
client-facing body means the random token is scanned by `assertDiscreet` along
with everything else, and 32 base64url characters land on a four-letter
deny-list term about once in 36,000 — at three reminders a week for seventy
standing clients, a send that throws in the middle of a horizon run a couple of
times a year. The whole failure class costs one `while` in the generator.

---

## 9. Where authentication would attach

The last P2 item is two-factor auth for clinical roles, and the right build was
not to build it.

There is no authentication in Clearpath. Adding a login that always succeeds,
or a TOTP field seeded with a fixed secret, would not have taught anything about
access control — it would have added a thing that *looks* like a security
control to a project whose entire argument is that its access control is real.
A check that cannot fail is worse than an absent one, because it reads as
present.

What did get built is the part that is genuinely this project's business: the
**policy**. `requiresSecondFactor(role)` sits in `permissions.ts` beside
`requiresCoSignature`, because which roles need a second factor is a
role-derived rule and that file is where every role-derived rule lives. An
identity provider attached later reads it; it does not restate it, and there is
no second place for the two answers to disagree.

The line is drawn by capability rather than job title. The three clinical roles
reach notes. Front desk does not, and their credential is worth a list of names
and times. The practice manager is on the list despite not being a clinical
role at all, because break-glass makes theirs the most valuable credential in
the building: a stolen admin session is one typed reason away from a client's
record, and the audit log would record that access faithfully, as them. The
break-glass design that makes admin access *visible* is exactly what makes
admin credentials *worth stealing*, and those are the same sentence.

`Session` carries `secondFactor: { required, satisfied }` where `satisfied` is
always false and nothing reads it — the seam, named, in the type. And the person
picker marks those roles "2FA seam" with the reason, so the gap is visible in
the product to anyone who opens it, rather than in a comment in a file nobody
opens.

---

## 10. The confirmation loop, and the money at the end of it

**The ask.** Text clients before every session, require a response, and mark
anyone who does not answer as a no-show with a fee.

**The objection, made once and not withdrawn.** In counseling, non-response
correlates with the reason people are attending. A depressed client who does
not answer texts is displaying a symptom, not defaulting on an obligation, and
a policy priced against silence falls hardest on the clients least able to
break it — and the practice will learn about that as attrition rather than as
complaints. That is a clinical decision and not an engineering one. The
recommendation on the record is to ship the loop and the work list, watch a
quarter of data, and turn the money on afterwards. The owner asked for the
charge, so `autoNoShowOnNoResponse` ships defaulting to **on**, and the flag
exists so that reversing it is one row rather than a deploy.

Everything below is the engineering that follows from taking the ask seriously
while refusing to let it conclude more than it knows.

### The field that is not the other field

`confirmation` is `not_required | pending | confirmed | declined | no_response`,
and it lives beside `status`, never inside it.

"Did you answer my message" and "were you in the room" are answered by different
evidence, and only the second is what a no-show fee is about. Merged into one
column, the indefensible case — charging a client who came — becomes reachable
by writing no code at all. Kept apart, it is unreachable by construction: the
sweep may write `no_show` only from `scheduled`, so a front-desk check-in always
wins and a client mid-session cannot be touched. The seeded quarter contains
102 sessions that end `completed` / `no_response`. Every one of them is charged
the session fee. That set is the whole feature.

The policy is a pure function of two fields and one flag, so the truth table —
eight statuses × five confirmations, and `no_show` reachable from exactly one
cell of it — is asserted in a millisecond without a database. It was checked by
planting violations rather than by being read: letting the sweep reach an
`arrived` client fails four specs, and dropping the eligibility re-check fails
two.

### Three guards in front of the money, and each is a re-check

The argument this code has to survive is that a practice charged somebody for
not answering a text.

1. **The practice must have asked.** `confirmationRequired` is one pure function
   both the send path and the fee path call, and its denials are the half that
   matters: `reminderPreference: 'none'`, a chosen channel with no address on
   file, and a booking made with less notice than the grace period. It is
   evaluated again in the sweep, at the moment of the fee — not trusted from the
   moment of the send — so a client who moved to `none` mid-cadence is exempt
   whichever job reaches their row first.
2. **The message must exist.** `pending` is written only by the cadence, and only
   when it actually queued something. The sweep additionally requires an outbox
   row before it will charge, which is unreachable today and is there to say
   what happens the day it stops being. Charging for silence the practice cannot
   prove it asked about is the failure this feature would deserve to be
   remembered for.
3. **The lint, for the code nobody has written yet.** A module that concludes a
   client did not answer must, in the same file, be seen to have asked whether
   asking was allowed. That catches the backfill script somebody writes next
   quarter to tidy up old `pending` rows and hands the fee rule a set of clients
   on the safety setting — a change every behavioural test would pass, because
   none of them call it.

Guard 3 exposed a hole in an older lint on its first run. `status: 'no_show'`
inside a report's `where` clause looks exactly like a handler writing it, so the
auditor's new "show me the charges nobody decided" query tripped the rule that
keeps `no_show` writes inside `lifecycle.ts`. A lint that cannot tell a read
from a write either fails on every report or passes on every backfill. Both now
share one brace-stack check that answers it structurally, and both are asserted
against a planted violation rather than only against the current tree.

### The reversal ships with the charge

An automatic charge without a way to undo it is not a policy; it is a bug with a
settings page. So `waive` is a matrix action, admin only, and adding it expanded
the permission matrix from 455 cells to 546 — every new denial asserted, front
desk's included.

`waive` is deliberately not `update`. Reversing a charge the practice made
automatically is a different decision from correcting a fee, and it is the
practice manager's alone: front desk runs the calendar and takes the phone call
from the client who is upset about the charge, which is exactly why they must
not be the one who can make it go away. As a matrix cell that sentence is
answerable by reading one file.

The flag goes to zero, so every total that already sums `chargeFeeCents` stays
right with no change to any of them, and what *was* charged goes into the audit
row — the difference between undoing a charge and pretending it never happened.
Waiving touches neither `status` nor `confirmation`: the client still did not
turn up, and the practice chose not to charge for it, and those are two facts.

### The one column the clock did not write

Phase 3 left a finding rather than a fix. `Appointment.createdAt` was the single
instant in the application filled by `@default(now())`, which means the
*database* clock filled it — and the pg adapter labels that value in the
session's timezone rather than in UTC. Every column the application writes goes
through that lens in both directions and cancels out; this one does not.

It matters because `dueStages` reads `createdAt` as the notice a booking had, so
it decides which reminder stages were ever sendable and therefore whether
silence can become a fee. West of Greenwich it reads back earlier than it truly
is — five hours on the laptop it was found on — which *widens* eligibility
rather than narrowing it. Wrong direction for a rule with money on it, and
invisible on a UTC box, which is every box CI runs on.

The fix is two lines and a lint. Hard rule 7 has no exception for column
defaults, and the grep is what covers the insert written next month, which would
otherwise get the database's clock back and fail nothing until a fee landed on
the wrong side of a stage boundary.

### A quarter that was lived rather than assigned

The seed used to write the past quarter with a bulk update and a die roll. That
was fine while the interesting facts were attendance and notes, and it stopped
being fine the moment a fee depended on a due-date-driven loop: a `confirmation`
column assigned by hand proves nothing about the job that is supposed to assign
it.

So the quarter is simulated. Every day gets a horizon run in the morning, the
clients who are going to answer answer through their own tokenized door, and the
sweep runs at midnight — 1,355 reminders, 3,300 audit rows, all of them
consequences of shipped code. Client behaviour is dealt from a fixed cycle
rather than rolled, because a 5% behaviour sampled 1,100 times lands between
3.7% and 6.4% often enough that "the rule is over-firing" and "the seed rolled
badly" would be indistinguishable — and that is precisely the spec that cannot
afford the ambiguity. It comes out at 34 charges from 692 eligible sessions:
4.91%. It costs 24 seconds.

Simulating it found two things a bulk update had been hiding. Clients were
confirming off messages that did not exist yet — a stage falls due at the
appointment's own hour, so "answered off the five-day message" can only happen
the day after that message went, and the seed threw rather than quietly
recording an answer nobody could have given. And group sessions broke the notes
loop: five attendees in one room with one clinician, four of them on somebody
else's caseload, and `create: 'treating'` refuses a note for a client you do not
treat. Both are the system being right and the fixture being wrong, which is the
direction you want that to run.

The fifteen success metrics then run at the end of the seed itself rather than
as specs, because every one of them is a statement about a whole simulated
quarter and reproducing that inside a test that truncates between cases would be
reproducing the seed. The seed refuses to finish if any fails. Checked by
planting a fee against a client on `reminderPreference: 'none'`: two go red.

### What shipped before the money, and why the order is the argument

The front-desk work list — unconfirmed, starting soon, oldest first, with the
phone number — is the half of this feature that is not a charge, and a practice
that ships the fee without it has automated a penalty and called it a feature.
Clients on `reminderPreference: 'none'` appear in it flagged **never asked**
rather than filtered out: they can never be charged for silence, which makes
them exactly the people somebody should ring, and hiding them would let the
exemption reappear as an absence nobody notices.

---

## 11. The reply nobody is allowed to read

Two P1 items, and they pull in opposite directions in a way worth writing down:
one *reduces* the number of messages the practice sends, and the other accepts
messages back.

### Capping the cadence, because volume degrades the evidence

Three messages a week to seventy standing clients is about eleven thousand
messages a year. The obvious objection is cost and the obvious answer is that
SMS is cheap — which misses it. The failure mode is that the reminder stops
being read, and the reminder being read is the entire basis for treating silence
as an answer. Left uncapped, the policy erodes its own evidence and then bills
people for the erosion.

So a client who has confirmed the last four times running drops to the
day-before message alone, until they miss one. **The asymmetry is the design.**
Earning the quieter cadence takes four answers; losing it takes one. A client
drifting out of the habit — which, per Risk 1, is often the clinical signal
rather than the noise — has their full cadence back on the next horizon run,
before the drift can cost them a fee.

The streak is *derived*, never counted. A `confirmationStreak` column would be
one read instead of a query and a second copy of a fact the appointments already
hold, so a corrected row or a backfill would leave the two disagreeing — in the
direction of sending people fewer messages than they should get, which is
exactly the direction nobody would notice. The lookback is bounded at three
weeks per session, and that bound is part of the rule rather than a concession
to the query planner: a client whose last four confirmations were a year ago is
not a standing client with an earned cadence, they are somebody coming back.

The cap narrows which stages exist and changes nothing about eligibility. One
message is still asking. A capped client booked inside the day-before window
gets nothing at all — which keeps `no_response` unreachable with no message
behind it, the same invariant the whole fee rests on.

**The seed found the mistake this feature invites, which is the reason to
simulate rather than assign.** The old loop had clients answering "off the
five-day message" at a fixed offset, and a capped client has no five-day
message. Every capped client silently became a silent one, and the non-response
count rose by a third with nothing failing. The loop now runs the cadence hourly
through the practice's day and lets people answer the message they just got —
more faithful, and what a real deployment does, since the job is idempotent and
due-date driven. Measured: 1,168 reminders where the uncapped cadence sent
1,355, with the answer rate and the fee count unchanged.

### The inbound channel, and the thing it refuses to be

Q1 resolved as "both": the tap-link ships first, and a client who texts back in
words anyway should be understood rather than met with silence. What that must
not become is an inbound channel that *stores* what they wrote.

A person can reply to a reminder with anything. Some of them will reply with the
most acute thing they have ever written, to a number the front desk monitors.
Storing that body would put clinical content on an operational surface (hard
rule 3) and route it to the one desk that must never see it (hard rule 9).

So the message is classified in memory and dropped. **`InboundReply` has no
column to put a body in** — that absence is the guarantee; the grep test is only
the guard for the migration that adds one. The spec plants a sentence about
self-harm in a reply and then greps the row, the outbox, the alerts and the
audit log for it.

An unreadable reply does three things and none of them is showing anybody the
words: an `Alert` to the treating clinician alone carrying reason codes, an
auto-reply, and a line on the front-desk list saying "this client replied — call
them". The end-to-end spec asserts that the page does *not* contain the seeded
message, because a page that quietly rendered it would pass every unit test in
the file that forbids it.

Matching is whole-message, not substring. "Yes if my ride works out" is not a
yes, and a system that decides it is will confirm somebody's Tuesday on the
strength of a word order. When the cost of guessing is a client's hour or a fee,
the honest failure is `unparsed` — which reaches a person, who can ask.

### Two things the PRD did not say, and one it could not

**`STOP` is not a decline.** The PRD specified three classifications. A fourth
was necessary and the reason is that both alternatives are wrong: read as a
decline, `STOP` cancels a session the client never mentioned; read as
`unparsed`, it earns an auto-reply, and replying to an opt-out is the one thing
a carrier forbids. The correct response is to stop messaging them and say
nothing — which also takes them out of reach of the fee, because the cadence's
existing exemption branch pulls their live `pending` rows back to
`not_required`. It is flagged as a PRD amendment rather than smuggled in.

**The deny-list and the crisis line collided.** The auto-reply has to carry a
number a person picks up, and P1-3 says it must also carry the crisis line — but
`crisis` is *on the deny-list*, because it names why somebody might be attending,
on a lock screen, which is precisely the disclosure the list exists to prevent.
The two requirements are both right and cannot both be met literally.

The resolution is that the message says what the number is *for* rather than
what it is called: "If you need urgent help right now, call or text 988 at any
hour." The information survives the constraint. Dropping either one would have
been the easy wrong answer, and it is worth noticing that the constraint and the
requirement come from the same instinct — protect the person holding the phone.
988 is the real US line and the only real external number in this codebase,
because a plausible-looking placeholder on that particular path would be worse
than none.

**The endpoint is the only write in this application with no session behind
it**, and it can cancel an appointment. It is not left open the way the dev-mode
switcher is: a shared secret in the header, and with `INBOUND_WEBHOOK_SECRET`
unset it refuses everything rather than defaulting to open — a webhook that
quietly works without its secret is a webhook nobody notices is unauthenticated.
The route classifies nothing, decides nothing, and does not echo the message
back, because a carrier logs its callbacks and an echo is the same leak by a
longer route. The gap that remains is named in the route rather than papered
over: a shared secret proves the *caller* is the carrier and says nothing about
whether the carrier was told the truth about who sent the message.

### The report, and one vocabulary for one question

The confirmation report exists because Risk 1 is answerable only from data. Its
rates are against the sessions the practice was *allowed* to ask about — a
client on "no messages" was never in the denominator of a question nobody put to
them, and dividing by them would flatter the confirmation rate by exactly the
number of people the policy is forbidden to reach. `notRequired` is a column
rather than a footnote, because hiding it would make the exemption invisible in
the one place somebody is deciding whether the exemption is working.

And a decline now carries one of the reschedule request's four codes rather than
a parallel list. Two of them read oddly on a cancellation; that is the smaller
cost than two places to add a fifth reason and a client answering the same
question with different words depending on which button they came in through.

---

## 12. The carrier, and what "we asked" is allowed to mean

Every phase before this one could be honest about the fee only up to a point,
and the write-up said so each time: the precondition for charging a client for
silence was an `OutboxMessage` row. That row proves the practice *intended* to
ask. It does not prove anybody was asked.

The gap between those two sentences is where a practice charges clients for its
own failed sends. A disconnected number, a mailbox that bounces, a provider
that was down for the six hours the cadence happened to run in — every one of
them produces exactly the same evidence as a client ignoring you. Silence. So
the practice bills, and never finds out, **because the evidence of the failure
is the same shape as the evidence of the offence.** That is the property that
made this the first P2 item rather than the fourth: it is not a missing feature,
it is a way of being wrong that cannot be noticed from inside.

### The seam, and why the driver is still a stub

`carrier.ts` is a port and a state machine, both pure. `delivery.ts` is the only
thing that writes a row because of one. The split is the same one
`confirmation.ts` / `reminders.ts` made, for the same reason: the rule that
decides whether a client can be charged has to be assertable in a millisecond
without a database.

The only driver shipped is `simulatedCarrier`, and that is not a shortcut. A
real credential here would mean real messages to real handsets from a project
whose first promise is that it holds nothing real. What changed is that the seam
is now honest — a deployment writes a second `Carrier` and changes no policy
code at all — and that the *shape* of a provider is now modelled rather than
assumed away. A provider has two halves: a synchronous accept-or-reject, and
receipts that arrive later by webhook. A stub with only `send` would have been a
stub that could not say anything this phase is about.

`sent` and `delivered` are separate states, and the distinction is the whole
feature. `sent` means a carrier took the message — the old, weaker claim, now
named as the weak claim it always was. Nothing in this codebase lets it near
money, and there is a spec that says so, because "accepted" is exactly what a
future refactor would mistake for "arrived".

### Three rules about receipts, each from a way carriers actually behave

**Receipts are ordered by the carrier's clock, not by ours.** Webhooks arrive out
of order, retry, and duplicate. Ordering by arrival would let a re-delivered
`sent` callback overwrite the `delivered` that followed it — and since the fee
reads that field, somebody else's retry policy would be deciding who gets
charged.

**On a tie, failure wins — but only against a contradiction.** This one was
wrong first. Stated as "a tie changes nothing", it also dropped a `delivered`
receipt stamped in the same second as the acceptance, which is an ordinary thing
for a provider to do and a *progression* rather than a contradiction. The bug
did not surface from reasoning about it; it surfaced because a test fixture that
dispatched and delivered on one frozen clock could not get a message to
`delivered`, and the sweep then correctly exempted everybody. Two receipts that
disagree at the same instant mean the practice has no proof, so the no-fee state
is honest. Two that agree are just the wire being fast.

**A transient failure with attempts left is not `failed`.** It goes back to
`queued` with a backoff time on it. `failed` here means the practice is done
trying, because that is the only version of the word the work-list and the
report can act on. The retryable set is a whitelist of exactly one code: an
unknown code from a driver written next year is treated as permanent, since a
retry that eventually succeeds *restores the fee's precondition*, and a provider
bug should not be able to end in a charge.

### What the sweep does now, and the word it refuses to write

`runNonResponseSweep` asks `deliveryProven` before it asks anything about money.
One delivered stage is enough — requiring all three would let a hiccup on the
day-of nudge erase a `d5` message the client demonstrably received, which is
stricter without being more honest.

Where nothing arrived, the row lands on `not_required`, **not** on
`no_response`. That is the sentence this phase turns on. `no_response` is a
statement about the client, and the client did not do anything; the practice
failed to reach them. Writing the stronger word would put "did not answer" on
the record of somebody who was never spoken to — the same untruth as the fee,
minus the money. The audit reason is its own code, `confirmation_undelivered`,
so the trail never blurs *the practice may not ask* with *the practice asked and
it did not arrive*. The first is a rule. The second is a fault.

### The exemption had to produce a phone call

The delivery precondition, on its own, makes the system quietly worse at the
thing it is for. A client with a dead number stops being charged — correct — and
also stops being noticed. The practice would keep booking them, keep not
reaching them, and find out at the point they stopped coming.

So `unreachableClients` puts them on the front-desk work list, with the address
that failed, and a client drops off it the moment anything reaches them again —
no "mark as handled" button, because a list that has to be tidied is a list that
gets tidied instead of worked. `expired` is deliberately excluded: a message
abandoned because its hour started says nothing about the number, and sending
front desk to ring those people is how a work-list stops being read.

The same argument put the delivery rate on `/reports` next to the fee total
rather than on a page of its own. A practice reading "we charged 33 people"
needs "and 23 reminders never arrived" in the same glance, because the second
number is *why* the first one is what it is.

### What the seeded quarter now says, and two bugs it found

The simulated carrier runs on the same hourly tick as the cadence through the
whole quarter. The headline is that the honesty upgrade cost almost nothing:
**33 fees from 685 eligible sessions (4.82%), against 34 from 692 (4.91%)
before.** Of 1,176 reminders, 1,153 were delivered, 23 never arrived and 38 only
got there on a retry. Seven sessions were asked about and never reached, and
none of them was charged. That is the number the phase exists to produce, and it is now a
seed metric rather than a claim.

Getting there found two things, both of which were my own modelling errors
rather than defects in the rule:

**Seeded phone numbers were seven digits.** `555-0101` is the reserved fictional
form written short, and a carrier validating destinations rejects it — so the
first run failed *every* SMS client, 1,054 messages, a 65% failure rate. The
check was right and the data was unrealistic; the numbers are now the full
ten-digit fictional form. Worth recording because the failure was loud and
therefore cheap. The version of this that ships is the one where a validation
rule is quietly a little too strict on a slice of real clients, and the only
symptom is that some people stop getting reminders.

**A dead number is a property of the destination, not of the message.** The
first cut seeded permanent failures on the message id, which scattered single
failures across many clients and produced a quarter in which *nobody* was ever
actually unreachable — three sessions, where the metric wanted five. Which is to
say the simulation could not produce the population the entire feature exists to
protect. Permanent failures are now keyed on the address and transient ones on
the moment, which is what the two things actually are.

A third, smaller: the message id is a cuid, so hashing it made the quarter
different on every run, and this seed's metrics are hand-checkable statements
about *one* quarter. Everything the simulation decides now hashes data the
simulation itself chose. Verified by running the seed twice and diffing, which
is the only way that property is ever actually held.

### What this deliberately does not do

It does not attach a real carrier, and the README still says nothing sends. It
does not retro-charge: a receipt arriving after the sweep has exempted a session
cannot turn the exemption back into a fee, because the practice did not have its
proof at the moment it made the decision, and re-deciding money on late-arriving
evidence is a worse property than being slightly conservative. It does not make
delivery a *setting* — there is no flag to go back to charging on `queued`,
because that flag would be a knob for turning the honesty off.

## 13. The hour a decline gives back

Five phases went into what a client's silence means and what it may cost them.
This is the first one about what their *answer* is worth, and the direction is
the other way round: every list built before it protects the practice from
something, and this one is worth something to a client.

The observation is in the PRD's first paragraph and had been sitting there
unused the whole time. A counseling practice has no walk-in trade, so an hour
that empties is gone — it "costs the practice the whole fee **and costs a
waitlisted client the whole hour**." The confirmation loop was built entirely
around the first half of that sentence. But a decline five days out is not
primarily a fee that was avoided. It is five days' notice of an empty hour, and
five days is long enough to ring somebody who has been waiting six weeks.

### It is not a list of declines

The obvious build is "declines feed the waitlist", and it is wrong in a way that
takes a moment to see. A front-desk cancellation empties exactly the same hour
as a keyword reply. If the list only showed the ones that arrived through the
confirmation loop, the week would have holes in it that nobody was looking for —
which is the failure every work-list on that page exists to prevent, reproduced
by the newest one.

So the input is every future cancellation, and the confirmation is carried
through as a label rather than as a filter. What actually decides whether an
hour is worth ringing round for is the notice remaining, and that is shown on
every row.

### Continuity is not a preference

The match rule reads three things and the order they are written in is the order
they matter in. The client's stated weekdays and time window come second and
third. First is whose hour it is.

A `WaitlistEntry` in this schema belongs to a `Client`, and every client has a
`treatingClinicianId` that is not nullable. So a waiting client always has a
therapist, and offering them Tuesday at three because the hour happens to be
free is proposing that they see a stranger. In a practice where the relationship
is the treatment, that is not a scheduling near-miss. It is the one mistake this
list must not make, and it is checked before anything the client asked for
because no preference they stated can outrank it.

This changed a signature. `waitlistMatches` already existed, taking a slot of
`{ date, startMinute }` — no clinician, because until now nothing had ever
handed it a real one. Making `clinicianId` required rather than optional was the
whole of the fix: an optional field there would have been a field a caller could
skip, and the thing being skipped is the clinical rule.

### The bug the type error found

The one caller was the work-lists page, and it read:

```ts
const waiting = await waitlistMatches(actor, { date: addDays(today, 1), startMinute: 15 * 60 }).catch(() => []);
```

Two things wrong, and the second is the interesting one. It asked about a slot
nobody had freed — tomorrow at three, invented — so the section had been showing
candidates for a hypothetical hour for two phases. And the `.catch(() => [])`
was swallowing a real authorization denial: `client:read` for a therapist is
`treatingOrSupervising`, the call passed no target, and every clinician who ever
opened that page got a silent empty list where the system had actually refused
them. An empty waitlist and a refused read rendered identically.

Both are gone. The guard now passes the same self-target the neighbouring
work-lists use, and there is no catch — which is why the integration test for
the therapist path failed the first time it ran, correctly, and is the reason
that test exists.

### Four filters, no button

The list is derived, and nothing on it can be marked as handled. That follows
the precedent set by `unreachableClients` one phase earlier, for the same
reason: a "handled" button is a way for a problem to leave a screen without
leaving the practice. An hour drops off this list when it is filled, when the
clinician stops working it, or when it starts.

Which makes the filters the whole design:

- **An hour somebody was rebooked into is not free.** Checked against the
  clinician's live sessions, which is also what makes group sessions behave
  correctly without a special case: one attendee dropping out leaves the
  clinician running the group, so no opening appears, and only a group that
  emptied completely produces one.
- **An hour the clinician is not working is not free either.** This one is not
  an edge case. A week of annual leave cancels fifteen sessions, and without
  this filter the vacation work-list and this one would describe the same
  absence in opposite words — one as fifteen conversations to have, the other as
  fifteen hours to sell. The seed now cancels a session inside the vacation week
  on purpose, so that claim is a count rather than an argument.
- **The same hour is one opening**, however many cancelled rows point at it.
- **The hour has not started.**

Nothing else is hidden. The slot two hours out that will probably not be filled
is on the list, ranked last and labelled for what it is, because a system that
decides on front desk's behalf that a slot is hopeless is how an hour goes
quietly empty. `fillability` is a band on a screen and an ordering — it carries
no money, and no code branches on it. It deliberately does not put a boundary at
the late-cancel window, and there is a test asserting that it does not: that
threshold decides whether a client is charged, and a practice moving its fee
window to 48 hours has said nothing about which hours are worth ringing round
for. Folding the two together would be the cheapest available mistake.

### What the seed found

The metric was written before the data supported it, and it failed on the first
run: two freed hours, and a candidate for neither. Three separate things were
wrong, and only the first was a fixture problem.

The waitlist was seeded with dice — a random weekday half the time, a 4pm floor
half the time, spread over six clinicians. Under a continuity rule, eight such
entries will usually miss every opening, and they did. That is the same problem
the demo client already had, and it gets the same treatment: constructed
explicitly, from the openings the simulation produced rather than from a slot
invented to be matched. But only the first three, because a practice where every
freed hour has somebody waiting for it is not a practice, it is a fixture — and
it would erase the case the list has to handle honestly, which is the hour
nobody can take.

The second was that the metric asked the wrong actor. It ran as the practice
manager, and `client:read` for `admin` is `breakGlass` — so the number could
only be produced by opening a door that exists for a client in crisis.
Computing a metric is not a reason to open it. The list belongs to front desk,
so the metric reads as front desk.

The third was the real one. The quarter's own declines land where the simulation
stops: the loop runs to "today", so the only hours it frees *ahead* of itself
are the one or two answered on the last tick. That is a fact about where the
simulation ends, not about a practice — a real one on any given morning is
looking at several freed hours in the coming weeks. So the seed now gives back a
handful of the horizon's sessions through the same `cancelAppointment` the desk
uses, half of them as declines and half as calls to the front desk, spread
across the month so the list carries a range of notice rather than one band.

Six of them, plus the vacation-week one that must not appear: **eight offerable
hours, five with somebody waiting and three with nobody** — and the three are the
point as much as the five.

### One existing test broke, and it was right to

`nextMonday()` in the scheduling spec resolves to the first day of that
give-back window, and the spec clicked whichever appointment came first in the
document and expected a cancel form. It now finds a cancelled one, which
correctly offers no such form. Nothing regressed: the seed had become more
realistic and the spec's assumption — that the first chip on a day is one you can
cancel — had always been the fragile part. It now names a `scheduled` session
instead of taking whatever is first.

### What this deliberately does not do

It does not book. `waitlistMatches` has said so in a comment since the phase it
was written in, and the reason has not changed: an automatic rebooking would put
a client in a room with a clinician neither of them chose for that hour, and it
would move somebody's session without a person seeing that it moved.

It does not record that an offer was made. That was a real fork, and the cost of
deciding against it is honest: front desk can ring the same three people about
two different hours and this system will not know. The alternative was a table,
an audit story, and a new way for an opening to be dismissed without being
filled — and on the evidence of `unreachableClients`, the thing that keeps these
lists useful is that nothing can be tidied off them. If a practice running this
finds the re-ringing is the real cost, the fix is a record of offers, not a
dismiss button.

And it does not tell a waiting client anything. Every message in this system is
one the practice chose to send to a specific person about their own appointment;
"an hour came free, do you want it" sent automatically to a matching list is a
different kind of message, and it is the kind that goes wrong when two people
answer it.

---

## 14. The cadence a client chose, and the question nobody had asked

The cap in §11 was the practice guessing. Four confirmations running and a
client drops to the day-before message alone — a good guess, derived from
behaviour, and still a guess. This is the same shape of thing arrived at from
the other direction: a client says which messages they want, and the system
believes them.

Three values, and the interesting part is which three. `full` is all three
stages and stays the default — it is the only value nobody chose, and that is
what makes it a default rather than a setting. `day_before` is the single
message the cap already produces, spelled the same way on purpose: an earned
cadence and a chosen one that send the same message should not be two
vocabularies, or a report ends up with a row nobody can explain. `day_of` is the
case the PRD names.

There is deliberately no value meaning "nothing". That is
`reminderPreference: 'none'`, it is a safety setting rather than a volume one,
and it carries a consequence this field must never acquire — a client on `none`
is never asked and so can never be charged for silence. A second way to spell
it would be a second route to that exemption, reachable from a control that
reads like a taste in messages. The screen says so where the choice is made,
because that is the one mistake a person at a desk can actually make here.

### A stated preference is not overridden by an inferred one

The cap and the choice collide, and `stagesFor` is where that is settled: the
cap narrows `full` and nothing else. A client who has *told* the practice which
message they want has already solved the volume problem the cap exists for, and
solved it better than the inference can.

The alternative — fewest messages wins — reads safer and is not implementable.
A client who chose `day_of` and earned the day-before cap has no stage in
common, so the rule needs a tie-break that nobody asked for and that neither
setting predicts. The version that survives contact is the simple one.

One consequence worth naming: such a client is not *reported* as capped either.
The cap did nothing to them, and a count that mixed "earned the shorter cadence"
with "asked for one" would mean two things and measure neither.

### The seed caught the feature over-firing

The plan was: ship the setting, note that a lighter cadence is still
fee-eligible, done. One delivered message is still asking — the same rule the
cap already lives under — and the alternative is worse than it looks, because if
a lighter cadence meant "not chargeable" the setting becomes a way to opt out of
the policy and every client finds it eventually.

Then the seeded quarter refused to finish:

```
✗ at most 5% of the sessions it could ask about end in a fee — 35 of 696 (5.03%)
```

The PRD does not treat that line as a target to aim near. It says: *"If the
number charged exceeds 5% of eligible, the rule is over-firing and the spec
fails."* So the first question was whether this was dice — adding one `chance()`
call per client moves the whole random stream, and every number in the quarter
with it — or whether the feature had actually done something.

It had. Broken down by cadence, against a scripted baseline of about 20%
silence:

| cadence | median gap, delivered → start | no reply | n |
|---|---|---|---|
| `full` | 119 hours | 19.7% | 578 |
| `day_before` | 23 hours | 5.0% | 40 |
| `day_of` | **1.0 hour** | **23.6%** | 110 |

A day-of client's only message was arriving with an hour to spare, and clients
who meant to answer were running out of time to. Every one of those becomes a
fee.

### The half of the question this system had never asked

`graceMinutes` checks there was time to **ask**, measured at booking, before
anything is sent. Nothing checked there was time to **answer** — and for five
phases nothing needed to, because a full cadence puts the first message five
days out and the answer was always obviously yes. A per-client cadence made it
not obviously yes, and the seed made it a number.

So `answerable` joins `confirmationRequired` and `deliveryProven` as a third
precondition, with a third audit code and a third grep lint. The three read as
one sentence each: the practice may not ask; the practice asked and it did not
arrive; the practice asked and it arrived too late to act on. Only the middle
one is a phone call, which is why only that one has a work-list. This one is a
*settings* signal — a cadence whose message keeps landing inside the window
cannot support the fee — so it goes on `/reports` beside the delivery rate and
the money, as a count rather than as a slow drift in the charge rate.

It is not an exemption for wanting fewer messages, and there is a test saying
so: a day-of client whose single message arrives with the whole lead ahead of it
is charged for silence exactly like anybody else.

The default is 120 minutes and that is a judgement, not a derivation — shorter
than a working morning, longer than a meeting. It is a setting because a
practice with a different channel mix may have a different honest answer, not
because there is any doubt about which direction is safer. Zero turns it off,
and off means the fee goes back on messages that arrived with minutes to spare.

### What it did to the numbers, and what that costs

The charge rate went from 5.03% to **4.57%**, and 17 sessions were exempted for
arriving too late against 14 exempted for never arriving at all. Day-of clients
fell from 23.6% no-reply to 9.7% — which is *below* the full-cadence cohort, and
that is the cost stated plainly rather than the win.

The rule cannot tell "did not answer because there was no time" from "was never
going to answer". It exempts both, and a day-of client who genuinely no-showed
may now escape a fee that a full-cadence client would have paid. That is the
same direction of conservatism the delivery precondition chose, for the same
reason: the practice can still mark a no-show by hand, and what it may not do is
charge automatically on evidence this thin.

One number in that table is a simulation artifact and should not be read as a
finding. The seeded carrier settles receipts on the *next* hourly tick, so a
day-of message queued at three hours out is delivered at two — which is exactly
the 2.0-hour median the quarter now shows, sitting right on the threshold. A
real carrier delivers in seconds, so a real day-of client would have close to
the full lead and far fewer of them would be exempted. The mechanism is real;
that particular exemption rate is the seed's clock granularity.

### Two fixtures that had been describing a practice nobody runs

The new precondition failed nine existing sweep tests on first run, and every
one of them was the fixture rather than the rule. The shared `asked()` helper
ran the horizon once, two hours before the session — queuing a "five days out"
message five days late — and stamped every delivery an hour before the start.
Harmless while nothing asked how long the client had; a compressed timeline
describing a cadence no practice runs, the moment something did. It now walks
the real leads. The group-session fixture had the same bug with a sharper edge:
its delivery was pinned to this suite's 3pm constant while the group sits at
11am, so it landed an hour before an appointment four hours earlier.

The e2e suite lost one too, and for a third reason. Moving the random stream
made the dice deal TC-006 a note awaiting co-signature — which the demo block
then added a second copy of, because it always constructed one instead of
guaranteeing one existed. The spec that co-signs a note and expects the queue to
empty found the other one still sitting there. The block now checks first.

### What this deliberately does not do

There is no portal control for it. The portal is a tokenized door with no login
behind it, and a forwarded link should not be able to change how somebody is
contacted — so a client says this on the phone or in the room, and it is a staff
edit on the record, audited like any other. That is the obvious next step and it
needs a think about what a token may do, not just a form.

And the channel itself — `email` / `sms` / `none` — is still not editable in the
UI, which is now a visible gap rather than a hidden one: the cadence picker sits
directly under a channel the same screen can only display. The code has
anticipated it being editable since P0 (the cadence exempts a live `pending` row
when a client moves to `none` mid-cadence), so the machinery is there. It is a
form, and it was not this item.

---

---

## 15. A deny-list in one language protects clients in one language

The last named P2 item read like a copy task — write the bodies in Spanish —
and it was two gaps, one of which was a privacy hole.

### The list, not the bodies

The messaging module's argument has been the same since the first commit: a
reminder arrives on a lock screen, in a shared inbox, on a phone somebody else
picks up, so it says when and where and never why. `assertDiscreet` enforces
that at send time. It was English-only. A Spanish-speaking client received a
neutral English body vetted against a list that did not contain the word
*terapia* — protected by a rule written for somebody else's language.

Three decisions came out of fixing it.

**A body must be discreet in every shipped language, not only the client's
own.** The person reading a lock screen is whoever is standing there, and a
practice serving two languages has clients whose partners and parents read the
other one. Checking only the client's list would protect them from their own
language and nobody else's. So the check is the union, an English body is now
vetted against the Spanish list, and the false friend — a word innocuous in one
language and disclosing in the other — is caught without anybody having to
notice the coincidence.

**Comparison folds accents**, because people type without them, and a list that
catches *depresión* but not *depresion* has a hole in it shaped exactly like an
ordinary keyboard. That fold closed a gap nobody was looking for: the Spanish
entry `clinic` (from `clínic`) catches the bare English word, which the English
list never had. It listed `clinical` and stopped. There is a spec pinning it,
because it is the kind of thing a later cleanup removes as redundant.

**The Spanish list is not a translation of the English one.** `consejeria` and
`consejo psicologico` are separate words that both disclose; `trastorno` has no
single entry above it; and `tratamiento` is listed bare where English lists
`treatment plan`, because "su tratamiento" on a lock screen says as much as the
full phrase does. Translating word for word would have produced a shorter and
worse list — which is the general shape of the mistake this item invites.

### A message nobody can read still counts as having asked

The interesting rule is what happens when a template has no body in a client's
language, and the answer is that **nothing is sent, so nothing can be charged**.

The tempting alternative is an English fallback: the client gets *something*,
which feels more helpful than silence. It is the trap. The cadence would count
that message as the practice having asked, promote the row to `pending`, and
the sweep would then charge somebody for not answering a question they could
not read — the precise failure this whole feature was built to make
unreachable. Sending nothing puts them in the same place as
`reminderPreference: 'none'`: never asked, and so never billed.

That branch is a safety net rather than a plan. A completeness test refuses to
let a partially translated language ship at all, so the condition it guards
against is one the suite will not allow — which is the right order: the
structural check prevents it, and the runtime check means the prevention
failing is not also a fee.

### The token two languages disagree about

The inbound keyword lists needed the same treatment, and one rule there is
worth more than the vocabulary: **a token meaning "yes" in one shipped language
and "no" in another comes back `unparsed`.**

It is the same principle as "yes if my ride works out" — when two readings are
available and the cost of picking wrong is somebody's hour or somebody's money,
this system does not pick, it puts a person on the phone. The client's own
language is consulted first, so a Spanish speaker who types "yes" is still
understood, but being first is not the same as winning. There is no such
collision between English and Spanish today and a test says so; the rule exists
for the third language, added by somebody who will not think to check.

**Opt-out keywords stay English in every language.** `STOP` is what the carrier
and the regulator recognise regardless of what the client speaks, and
translating them would invent a second opt-out vocabulary that the network
below this code does not honour — a client texting `PARAR` to a US short code
is opted out by nobody. `PARAR` is accepted here as well, because a client who
types it plainly means it and the practice can act where the carrier will not.
That asymmetry is the honest shape of a rule that is half regulation and half
courtesy.

### The half a translation stops at

A Spanish reminder that says "avísenos si va a venir" and links to an English
page with two English buttons is half a sentence. The client cannot complete
the loop, and the fee rests on them completing it. So the door is translated
too — every string, the weekday names, and the fee disclosure, which is the one
sentence with money in it and keeps its figures as numbers in both languages so
a translation cannot get the amount wrong.

Two screens stay deliberately bilingual. A dead link resolves to nobody and so
to no language either; whoever is holding one is exactly the person the page
knows least about, and saying it twice is right there.

The forms are still English, and that is the remaining gap rather than an
oversight: a screener's wording is clinically validated per language, and a
mistranslated item changes what the score means. That is not a copy task and
should not be done by somebody who cannot validate it.

### What the quarter says

14 of 70 seeded clients read Spanish, derived from the client number rather
than from the dice — the previous phase's handoff recorded that one extra
`chance()` call in the client block moves the whole stream and breaks metrics
unrelated to the change, so the fixture avoids the trap rather than rediscovering
it. Every pre-existing figure is unchanged, charge rate included.

The metric worth reading is that a translated client is charged at 4.48%
against the practice-wide 4.57%. The claim is deliberately not "Spanish
speakers are never charged" — that would be a different and worse policy,
patronising in one direction and unfair in the other. It is that they are
charged at the same rate, because they were asked in a language they read.

---

## Decisions log

| Decision | Why |
|---|---|
| `process_note` and `progress_note` as separate resources, not one with a flag | A flag invites scattered `if (note.private)`; separate resources put the difference in the policy table where it is testable |
| `can()` returns a `Decision`, not a boolean | The audit log needs the rule that fired and whether break-glass was open; a boolean forces every call site to re-derive it |
| A `client` role in the matrix, empty on purpose | A tokenized submission gets an honest actor in the audit trail instead of being attributed to staff |
| Supervisor reach extends to a supervisee's caseload, except process notes | Countersigning blind is not supervision; the single exception is sharper against a full record than against an empty one |
| Denials logged outside the caller's transaction | A rolled-back request must still leave the attempt on the record |
| A freed hour is every future cancellation, not every decline | A front-desk cancellation empties the same hour; a list of declines would leave holes nobody was looking for |
| Continuity checked before any preference the client stated | Offering another clinician's hour proposes a stranger, and no stated preference can outrank that |
| `waitlistMatches` takes a required `clinicianId`, not an optional one | An optional field there is a field a caller can skip, and the thing skipped is the clinical rule |
| `fillability` bands deliberately miss the late-cancel window | One threshold decides whether a client is charged, the other how a row is sorted; folding them together is the cheapest available mistake |
| A cadence a client chose beats the cadence they earned | The cap is the practice guessing from behaviour; a client who said it outright has answered better, and "fewest messages wins" needs a tie-break neither setting predicts |
| No cadence value meaning "no messages" | That is `reminderPreference: 'none'`, a safety setting carrying an exemption from the fee; a volume control must not be a second route to it |
| A lighter cadence is still fee-eligible | One delivered message is still asking; if it were not, the setting becomes an opt-out from the policy and every client finds it |
| `answerable` as a third precondition, not a cadence-specific exemption | The system checked there was time to ask and never that there was time to answer; that gap was invisible at five days' notice and load-bearing at one hour |
| The answering window is a settings row, surfaced on the report, not a work-list | An undelivered message is an address problem with a phone call behind it; a message that arrives too late is a *cadence* problem, and the practice needs to see it as a count |
| No record that an offer was made, and no "handled" control | What keeps these lists useful is that nothing can be tidied off them; the cost is re-ringing, and the fix for that would be a record of offers, not a dismiss button |
| List reads logged once, not once per row | Forty audit rows for one page view buries the individual record opens that matter |
| `may()` is silent | Deciding which buttons to draw is not an access event, and logging it would drown the real ones |
| A separate `messagingName` on practice settings | "Stillwater Counseling" on a lock screen tells a roommate what the appointment is for; the deny-list catches exactly that, so the practice needs a short name |
| Dark mode follows the OS, with no in-app toggle | One less piece of state to get out of sync, and the OS already knows it is 9pm |
| TRUNCATE still permitted on the audit table | Blocking UPDATE and DELETE stops every rewrite an application bug or a hand-run query could perform; wiping the whole table is an obviously administrative act, and tests need it. Real tamper-evidence needs the log shipped off the box — claimed nowhere |
| The two hard rules that grep can check are tests, and they scan `app/` too | The role-check lint scanned only `src/`, so the layer the rule actually names — endpoints, loaders, components — was unguarded; the clock rule had no test at all. Both now fail on a planted violation, which is the only reason to trust a lint |
| Seven type steps, not twelve | The app had improvised sizes from 9.5px to 22px — nobody could tell 12px from 12.5px on purpose. The workhorse stays at 13px so the dense clinical tables did not move, and a test refuses any new arbitrary pixel value |
| `--on-solid` instead of white on solid fills | In dark mode the danger and private fills are light, and white on them fails contrast. Four buttons had hardcoded `#fff`; a solid button is the one place the foreground cannot be inherited |
| The mark is the tier model | Three rings — operational, clinical, private — and a path that comes in from outside and stops before the core. It is the product's argument at 16px, and it costs one colour |
| The style guide imports the components rather than redrawing them | A guide that redraws its specimens starts lying in week one. `/design` renders the real primitives reading the real tokens, so it is wrong only when the app is wrong |
| The integration suite runs on a 20s test timeout, not vitest's 5s | The per-test `TRUNCATE` and the ten-racer booking test are both dominated by WAL fsync, which moves with whatever else the machine is doing: the race asserted correctly on every run and still timed out on one run in four. An alarm that fires on disk latency instead of on a broken invariant trains you to rerun it, which is how a real failure gets waved through |
| The author-only rule gets a structural lint, not just behavioural tests | The suite proved the helpers that exist refuse the wrong reader. It could not say anything about the helper written next month: a `processNote` query that filters by client and forgets the author passes every existing test, because none of them call it. The lint reads the shape of the call instead — `authorId` must appear inside the query, which is the difference between filtering in SQL and filtering in JS. Two read-backs that had leaned on a preceding author-filtered `updateMany` now filter for themselves, so the rule has no exceptions to remember |
| The superbill reads the fee stored on the appointment, not the client's fee today | The completion transition already recorded what the session cost, for the late-cancel logic. Billing a March session at September's sliding-scale rate is wrong in a way no reader of the document could detect |
| Booking takes a per-slot advisory lock before it inserts | The exclusion constraints make a double-booking impossible but they do not make a *rejection* truthful: outside a lock, `23P01` means either "that room is booked" or "someone is part-way through booking it and may roll back", and ten concurrent bookings of one hour therefore all walk past a room that ends up empty. Measured at three runs in forty. Inside the lock a conflict is a committed conflict, the deadlock storm disappears with the shared lock ordering, and 150 rounds pass in 7s where 40 used to take minutes |
| A trend refuses to compute a change across a template version | Scoring rules version with the template, so totals either side of a revision measure different things. A line drawn through them renders a rules edit as clinical movement |
| Screener trends live on their own page, not on the client record | A chart of somebody's mental state over time should not be something you meet while looking for their phone number. Reaching it is a deliberate navigation, and the read is logged as one |
| A group session is N appointments sharing a key, not one appointment with N clients | Notes, fees, attendance, audit rows and the superbill are all about a person rather than an hour. Keeping the appointment singular meant none of them changed, and attendance-level notes needed no work at all |
| The group key enters the exclusion constraints as `COALESCE(groupSessionId, id)` | A bare `groupSessionId WITH <>` compares NULL to NULL for every pair of ordinary appointments, which is NULL rather than true, so the constraint would stop rejecting anything and every existing test would still pass. Falling back to the row's own id keeps individual bookings conflicting |
| Rescheduling an attendee clears their group key | The exemption that lets co-attendees share a clinician has to end where the shared hour does, or two rescheduled attendees can land on each other |
| The portal's reschedule request is a reason code, with no free-text field | A message box on a client-facing page is a channel for clinical content to arrive at the one desk that must never see it. Front desk phones them; that conversation is not this system's to hold |
| The portal shows no appointment type | "Intake" and "extended" describe a clinical shape. It is on the messaging deny-list for the same reason, and a leaked link should disclose times, not care |
| 2FA is a tested policy function and a named seam, not an implementation | A login that always succeeds is worse than no login, because it reads as a control. What belongs here is which roles need one, and that is a role-derived rule, so it lives beside every other role-derived rule |
| The practice manager needs a second factor despite not being a clinical role | Break-glass is one typed reason from a record, and the log would record it faithfully as them. The design that makes their access visible is what makes their credential worth stealing |
| The README's screenshots are captured by a spec, not taken by hand | A hand-taken screenshot is a claim about the product on the day someone remembered to take it. `npm run shots` drives the real build against the seeded practice, so a picture that has gone stale is a spec that fails to find what it is pointing at |
| Producing a superbill needs both the fee and the demographics permission | It is both records at once. Guarding it twice meant no new matrix row and no new question: whoever may already see both halves may produce it, and the practice manager still has to break glass, because billing is not a carve-out from the rule that their clinical reach is logged |
| A token read as `var(--status-${x})` is invisible to every search for it | The cleanup pass deleted eight status colours as dead after grepping the codebase for their names. They are built dynamically in `AppointmentChip`, so nothing ever spells one out, and the calendar lost its status edge silently — no test failed, because no test asserts a colour. What caught it was the screenshot spec: the calendar capture came back stable across runs but different from the committed one. That is the argument for screenshots being a spec rather than a picture, and the reason dynamic token construction now says so in a comment at the definition |
| Nine list pages rendered their refusals as crashes | The record pages caught `Forbidden` and showed a panel; the list pages never did, so any role could reach a 500 by typing a URL — `/audit` as a supervisor, `/clients` as the auditor, `/book` as the practice manager. Every permission decision was correct and every denial was audit-logged. The failure was in the last inch, which is the worst place for it in a project whose argument is that refusal is a designed, visible outcome rather than a fault. `withDenial` wraps the whole component rather than one query, because these pages fetch twice — a list, then the names to label it with — and a `try` around the first leaves the second free to throw past it |
| The denial spec walks the route tree instead of naming routes | Eight pages were found by hand and the ninth, `/book/group`, was found by the spec on its first run — a page nobody thought to open. Enumerating routes would have encoded the same blind spot the bug came from: each of the eight was written *after* the pattern that would have saved it, and a list of names cannot cover the page written next month. Reading `app/(staff)` from disk means a new page is covered the day it lands, which is the same reason the role-check and author-only rules are lints over the tree rather than tests over a list |
| Deploying meant admitting the demo needs a cloud database | Two guards refused one outright — `prisma.config.ts` for the CLI, `src/db.ts` for the running app — and the second would have taken the site down on its first request rather than at build time. The exemption is a named variable rather than a hostname allow-list, set by the Vercel build and the two `:prod` scripts and nothing else, because the case worth walling off is the accident: a mistyped `.env.test` pointing a sweep at a cloud branch, which never announces itself. The deployed practice is the same seeded fiction as `npm run db:seed` |
| The audit screenshot masks its timestamp | The three other captures are byte-identical run to run, because the seed is date-pinned; this one moved every time, and a picture that always differs teaches you to ignore the one time it differs for a reason — the same trap as a flaky test. The cause is not a defect: `AuditEvent.at` defaults to the database clock rather than the app's injected one, which is the single timestamp the application should not be able to choose. So the shot boxes the cell out instead, and the README says why |
| Confirmation is a field beside `status`, never a value inside it | "Did you answer my message" and "were you in the room" are answered by different evidence, and only the second is what a no-show fee is about. Collapsing them makes the indefensible case — charging a client who turned up — reachable by writing no code at all, which is the worst kind of reachable. The fixture the feature is judged on is `completed` / `no_response`: silent, present, charged the session fee and nothing more |
| `reminderPreference: 'none'` is an exemption in a pure function, not a hope about the job | The setting exists because for some clients a message on a phone somebody else picks up is a danger. A cadence that skips them but a fee rule that does not would convert a safety setting into a penalty for needing it. `confirmationRequired` is the single branch both the send path and the fee path ask, and its denials are the half of the test table that matters |
| A stage whose moment predates the booking is skipped permanently, not sent late | Booking two days out means the five-day message was never a message anybody could have sent. Queuing it on the next horizon run would be the practice asking a question it had no time to ask, and then billing the silence. The same rule makes a booking inside the day-of lead produce no stages at all — which is what keeps `no_response` unreachable without an outbox row proving the ask |
| `no_show` writes are a lint, not a convention | It is the one status a scheduled job can now reach on its own, and it carries money. The behavioural tests can say nothing about the helper written next month, so the rule is a grep over `src/` and `app/` that fails on a planted violation — verified by planting one. Files with no database handle are skipped, because the design gallery rendering a no-show chip is not a way to write a status |
| The horizon is one transaction per appointment, not one per stage | The messages, their reminder rows, the promotion to `pending` and the audit row are one fact: the practice asked. Committing the outbox row and failing before the reminder row would leave a message a client received with nothing recording that it was sent, and committing the promotion without the messages would make `no_response` — and the fee — reachable with no evidence behind it. Losing a race to a concurrent run costs that appointment one cycle, which is the cheap half of the trade |
| The `@@unique([appointmentId, stage])` key is the idempotency guarantee; the pre-filter is only an optimisation | Reading the existing reminder rows and skipping the stages already there makes a second run cheap, but it decides on data read before the transaction opened — two runs a millisecond apart both read zero rows and both queue. So the constraint is what actually holds, and a `P2002` is read as "the other run got there first" rather than as a failure. The same discipline as `Appointment.occurrenceKey`, for the same reason |
| Switching to `none` mid-cadence pulls a live `pending` back to `not_required` | Stopping the remaining stages is not enough. A row left at `pending` is a row the non-response sweep will find, and it would charge a client for not answering a question the practice had already agreed to stop asking. The safety setting has to reach backwards into the state the cadence already wrote, or it is only a setting about future messages |
| The e2e fixture for the door is built through Prisma, not as raw SQL | The pg adapter stores a `Date` as its UTC wall clock labelled in the session's zone. Write and read cancel out, so the application is self-consistent and every unit spec passes — but a fixture row inserted by hand with `now()` reads back skewed by the machine's UTC offset, and an appointment two hours away came back as already past and vanished from the client's door. The same skew reaches any column the *database* clock fills: `createdAt` defaults to `CURRENT_TIMESTAMP`, and `createdAt` is what `dueStages` calls the notice a booking had. On a machine west of Greenwich that reads too early, which widens eligibility rather than narrowing it — the wrong direction for a rule a fee depends on. Fixed in the money phase: `bookAppointment` and `bookGroupSession` stamp it from the injected clock, and a lint requires every appointment insert to name it. It is invisible on a UTC box, which is exactly why it needed a lint rather than a test |
| The required response is a tap on a link, not a `YES` texted back | A message demanding a reply is more conspicuous on a lock screen than one that does not, and conspicuousness is not vocabulary — the deny-list governs words and cannot make a compulsory answer discreet. A keyword reply also opens an inbound channel front desk monitors, which a client can answer with a crisis disclosure. A link is one tap, works the same on SMS and email, needs no inbound channel at all, and puts the fee disclosure on a page where it can be read before it applies |
| The reminder carries the existing `PortalLink`, not a new per-appointment token | A second token type is a second expiry policy, a second revocation story, a second audit rule and a second thing to get wrong. The blast radius grows honestly instead: a forwarded link can now see appointment times, request a reschedule, **and** cancel — bounded by `classifyCancellation`, unable to reach another client's row, and every use on the record with the client as the actor |
| A decline cancels, though the reschedule request only asks | The portal's "it requests, it never books" rule is about creating commitments a person should see being made. A decline destroys one, and the practice's goal is a calendar that tells the truth — an hour the client has said they will not attend has to free the room, or the feature is theatre. The rail is that it routes through the same `cancelAppointment` front desk uses, so the 24-hour policy applies identically whoever clicked |
| The `client` role's one matrix cell, instead of a check inside the door | "What can a forwarded link do" should be answerable from the file that *is* the policy. Reading behind the link and asking for a different time change nothing and stay outside the matrix; confirming and declining change something, so they are a cell — `appointment: update` under a `token` rule that requires the row to belong to the token holder. The door still resolves ownership first, and still answers `NotFound` rather than `Forbidden`, so the second no never has to be given |
| The fee interstitial is a second tap, and the first tap changes nothing | Declining inside the late-cancel window is chargeable, so the first tap asks the server, the server decides from the clock, and the client is shown the amount in dollars before anything is cancelled. Outside the window there is nothing to disclose and the decline is one tap. Same code path, disclosure in front of one of them — the policy becomes something the client is told rather than something they discover |
| The portal token is re-rolled until it passes the deny-list | Once a link is substituted into a client-facing body, `assertDiscreet` scans the random token too, and 32 base64url characters hit a four-letter term like `ptsd` about once in 36,000 — roughly twice a year at this feature's volume, as a throw in the middle of a horizon run. One `while` in the generator removes the class for every template rather than for the one that surfaced it |
| The sweep may write `no_show` only from `scheduled` | A front-desk check-in and a client mid-session are observations; silence is an inference. Letting the inference overwrite the observation is how a client who turned up gets billed for not answering a text, and it is reachable by writing no code at all if the two facts share a column. The guard is one line, and the truth table around it is 40 cells asserted without a database |
| The flag governs the status transition and the fee, and never the record of the silence | Turning the policy off has to leave the practice with the evidence and the work list — the whole feature minus the money. If `no_response` were also optional, the week a client agreement gets reviewed the practice would lose the data it needs to review it |
| Eligibility is re-checked at the fee, not inherited from the send | A client who moves to `reminderPreference: 'none'` mid-cadence is not a client the practice may charge, and either job can reach their row first. Trusting `pending` because something once wrote it is trusting a decision made days earlier under different facts |
| A `pending` row with no outbox message behind it is exempted rather than charged | Unreachable today, because only the cadence promotes and only when it queued. The branch exists to say what happens when that stops being true, and the answer has to be "do not charge" rather than "assume the send happened" |
| `waive` is its own action, not a use of `update` | Reversing a charge the practice made automatically is a different decision from correcting a fee, and it belongs to the practice manager alone — front desk takes the phone call about the charge, which is exactly why the reversal is not theirs. As a matrix cell, "who can undo an automatic charge" is answerable by reading one file; as an `if` in a handler it is answerable by reading the handler |
| The waiver zeroes the flag and puts the original amount in the audit row | Zero is what keeps every existing total right without touching any of them. The amount in the trail is the difference between undoing a charge and pretending it never happened, and it needed one widening: a guarded request may now carry its own operational note, where before only a break-glass justification could write that column |
| `noShowFeeCents` ships equal to `lateCancelFeeCents` | A practice charging half for a cancellation with notice and the full hour for an empty room is ordinary, and one field cannot say both. Defaulting the new one to the old figure means the migration changed nothing on the day it landed — which the regression spec proves by passing on both sides of the change — so the field and the policy stay reviewable separately |
| A human-set `no_show` and a swept one produce the identical fee | The policy is about the fact, not about who noticed it. Two figures would make the sweep a second, quieter pricing rule that nobody chose |
| The audit reason code is derived from the confirmation, never from the operational text | The trail needs to say *what determined this*, and `no_response` or `declined` says it in one greppable word. The cancel reason front desk types is free text from a person, and free text in an audit log is one distracted afternoon from being clinical content — which is hard rule 3 |
| The write/filter distinction in the structural lints is a brace stack, not a regex | `status: 'no_show'` in a report's `where` clause is indistinguishable from a handler writing it by any line-local heuristic, and the auditor's new query tripped the existing lint on its first run. A lint that cannot tell a read from a write either fails on every report or passes on every backfill, so both lints now answer it from the enclosing block |
| The seeded quarter is simulated day by day, not assigned in bulk | A `confirmation` column written by hand proves nothing about the job meant to write it, and the success metrics are queries against exactly that data. Simulating it cost 24 seconds and immediately found two things the bulk update had hidden: clients confirming off messages that did not exist yet, and group attendees whose notes the matrix correctly refuses |
| Client behaviour in the seed is dealt from a cycle, not rolled | A 5% behaviour sampled 1,100 times lands between 3.7% and 6.4% often enough that "the rule is over-firing" and "the seed rolled badly" become indistinguishable — and the metric guarding against a policy that charges too many people is the one that cannot afford that |
| The success metrics run inside the seed and fail it, rather than living in a spec | Each is a statement about a whole simulated quarter, and reproducing that in a test that truncates between cases would be reproducing the seed. A seed that can produce data violating its own eligibility rule will, quietly, on the run nobody watched |
| The unconfirmed work list ships before the fee, and lists the clients who can never be charged | A practice that ships the charge without the list has automated a penalty and nothing else. Clients on `reminderPreference: 'none'` appear flagged *never asked* rather than hidden: they are precisely the people somebody should ring, and filtering them out would let the exemption reappear as an absence nobody notices |
| Confirmation on the calendar is a border treatment, not a sixth colour | `status` already owns the colour channel, and confirmation is an independent axis — putting two independent facts on one channel makes neither readable. A dashed edge and an ellipsis say "still waiting" without competing, and the dynamic-token incident above is the standing reason not to reach for a status colour by name |
| The confirmation streak is derived from appointment history, not counted in a column | A counter is one read instead of a query and a second copy of a fact the rows already hold. A corrected status or a backfill leaves the two disagreeing silently, in the direction of sending people fewer messages than they are owed — which is the direction nobody notices. The lookback bound is part of the rule too: a client whose last four confirmations were a year ago is somebody coming back, not somebody with an earned cadence |
| Earning the quieter cadence takes four answers; losing it takes one | The client who drifts out of the habit is, per this feature's own stated risk, often displaying the clinical reason they are attending. The asymmetry puts their reminders back before the drift can cost them a fee, and it costs the practice one extra message |
| The cap narrows the stages and never touches eligibility | One message is still asking, so a capped client who says nothing is still fee-eligible — otherwise the reward for being reliable would be a silent exemption nobody chose. And a capped client booked inside the day-before window queues nothing at all, which keeps the "no fee without an outbox row" invariant intact rather than special-casing around it |
| `InboundReply` has no column for the message body | A client can reply to a reminder with anything, including the most acute thing they have ever written, to a number front desk monitors. The schema having nowhere to put it is a stronger guarantee than any policy about not reading it, and it makes every future query safe by construction. The grep test is not the rule — it is the guard for the migration that adds a column |
| `STOP` is its own classification, not a decline (a PRD amendment) | Read as a decline it cancels a session the client never mentioned; read as `unparsed` it earns an auto-reply, and replying to an opt-out is the one thing a carrier forbids. The right answer — stop messaging, say nothing — is neither of the three the PRD named, so the fourth was added and flagged rather than forced into one that fits badly |
| Keyword matching is whole-message, never substring | "Yes if my ride works out" is not a yes. A substring match confirms somebody's Tuesday on the strength of a word order, and the cost of being wrong is an hour or a fee. `unparsed` reaches a person who can ask, which is the correct failure |
| The auto-reply says what the number is for rather than naming the crisis line | The deny-list forbids `crisis` because it names why somebody might be attending, on a lock screen — and P1-3 requires the one message that can carry an external number to carry that one. Both requirements come from the same instinct and cannot both be met literally; "if you need urgent help right now, call or text 988 at any hour" keeps the information and loses only the label. 988 is real, because a plausible placeholder on that path would be worse than none |
| The inbound webhook refuses everything when its secret is unset | It is the only write endpoint in the application with no session behind it and it can cancel an appointment, so it does not get the dev switcher's latitude. Defaulting to open would mean a webhook that works without its secret, which is a webhook nobody notices is unauthenticated. What it still cannot prove — that the carrier was told the truth about who sent the message — is named in the route rather than implied by its absence |
| The confirmation report's rates are against what the practice was allowed to ask | A client on "no messages" was never in the denominator of a question nobody put to them, and dividing by them would flatter the confirmation rate by exactly the count of people the policy may not reach. `notRequired` stays a visible column for the same reason: an exemption that disappears from the report disappears from the decision |
| A decline reuses the reschedule request's four reason codes | Two of them read oddly on a cancellation. The alternative is two places to add a fifth reason, two things for a report to union, and a client answering the same question with different words depending on which button they came in through. Reusing an imperfect vocabulary beats maintaining two |
| The fee's precondition is a delivery receipt, not a queued message | A queued row proves the practice intended to ask. A dead number, a bouncing mailbox and a provider outage all produce the same evidence as a client ignoring you, so charging on intent means charging clients for the practice's own failed sends — and never finding out, because the failure looks exactly like the offence |
| `sent` and `delivered` are separate states, and only one is allowed near money | `sent` is a carrier saying it took the message, which is the old precondition wearing a better name. Keeping them as one field would make "accepted" and "arrived" the same claim, which is precisely the conflation a future refactor makes for free |
| An undelivered session lands on `not_required`, never on `no_response` | `no_response` is a statement about the client, and the client did nothing — the practice failed to reach them. Writing the stronger word would put "did not answer" on the record of somebody who was never spoken to, which is the same untruth as the fee minus the money. Its own audit code, `confirmation_undelivered`, keeps the rule and the fault from blurring |
| Delivery receipts are ordered by the carrier's clock, not by arrival | Provider webhooks retry, duplicate and arrive out of order. Ordering by arrival lets a re-delivered `sent` callback overwrite the `delivered` after it — and since the fee reads that field, somebody else's retry policy would decide who gets charged |
| A tie between two receipts goes to failure, but a same-instant progression is applied | The first version of this rule said a tie changes nothing, and it silently dropped a `delivered` stamped in the same second as the acceptance — an ordinary provider behaviour and the fixture that found it. Two receipts that disagree at one instant mean no proof; two that agree are just a fast wire |
| The retryable failure set is a whitelist of one code | An unknown code from a driver written next year is treated as permanent. The cost of being wrong that way is one undelivered message; the other way is an unbounded retry loop whose eventual success *restores the fee's precondition*, letting a provider bug end in a charge |
| One delivered stage is enough, not all three | A carrier hiccup on the day-of nudge should not erase a `d5` message the client demonstrably received. Stricter is not the same as more honest, and it would hand somebody a fee-free session for the provider's bad afternoon rather than for anything either party did |
| Giving up on an expired message is ours, so it gets no receipt row | A receipt is something a provider said, and nobody said this: the practice ran out of time and stopped. "They did not get it" and "we gave up" are different sentences in a defence of a charge, and the work-list excludes `expired` for the same reason |
| Receipts the state machine ignored are still written | A trail that records only the receipts that won is not a trail. "The carrier contradicted itself" is exactly what somebody defending a fee needs to be able to see |
| `DeliveryReceipt` has no column for a provider's error string | A carrier's error text routinely quotes the message and the destination back at you, so keeping it is how a body and a phone number land in an operational table nobody thought of as holding either. The route refuses an unrecognised code rather than storing it |
| The delivery webhook has its own secret, not the inbound one | `/api/inbound` can cancel an appointment. A provider reporting delivery receipts has no business being able to do that, and one shared key would hand it that power. Two endpoints, two capabilities, two keys |
| The exemption produces a work list, not just a skipped fee | Requiring delivery makes the system quietly worse at its actual job: an unreachable client stops being charged *and* stops being noticed. A client drops off the list the moment something reaches them, because a list that must be tidied gets tidied instead of worked |
| The delivery rate sits beside the fee total, not on a page of its own | It is now the fee's precondition. A practice reading "we charged 33 people" needs "and 23 reminders never arrived" without changing pages, because the second number is why the first one is what it is |
| A permanent simulated failure is keyed on the destination; a transient one on the moment | A disconnected number is disconnected for every message sent to it. Keying it on the message id scattered single failures across many clients and produced a quarter in which nobody was ever unreachable — a simulation unable to produce the one population the feature exists to protect |
| Nothing the simulated carrier decides is hashed from a cuid | Message ids are random per seed run, so hashing one made the quarter different every time, and these metrics are hand-checkable statements about a single quarter. Verified by running the seed twice and diffing it, which is the only way that property is ever actually held |
| There is no flag to go back to charging on `queued` | Every other policy in this feature has a settings row behind it. This one does not, because that row would be a knob for turning the honesty off |
| A body is checked against every shipped language's deny-list, not the client's own | The person who reads a lock screen is whoever is standing there, and a practice serving two languages has clients whose partners and parents read the other one. Checking only the client's list protects them from their own language and nobody else's — and the union catches the false friend, a word innocuous in one language and disclosing in the other, without anybody having to spot the coincidence |
| Deny-list comparison folds accents | People type without them, and a list catching `depresión` but not `depresion` has a hole shaped like an ordinary keyboard. The fold also closed a gap nobody was hunting: the Spanish `clinic` catches the bare English word, which the English list never had — it listed `clinical` and stopped |
| The Spanish deny-list was written, not translated | `consejeria` and `consejo psicologico` are separate words that both disclose, `trastorno` has no single English entry above it, and `tratamiento` is listed bare where English lists `treatment plan`. A word-for-word translation would have produced a shorter and worse list, which is the mistake this whole item invites |
| A template with no body in the client's language is not sent, and so can never be charged for | An English fallback feels more helpful than silence and is the trap: the cadence would count an unreadable message as having asked, and the sweep would bill somebody for not answering a question they could not read. Sending nothing puts them where `reminderPreference: 'none'` does — never asked, never billed. A completeness test then forbids the condition outright, so the runtime branch is a safety net rather than a plan |
| A keyword meaning opposite things in two shipped languages resolves to `unparsed` | The same rule as "yes if my ride works out": two readings, and the cost of picking wrong is an hour or a fee, so the system does not pick — it puts a person on the phone. The client's language is consulted first without winning. No such collision exists between English and Spanish; the rule is for the third language, added by somebody who will not check |
| Carrier opt-out keywords stay English in every language, and the Spanish one is accepted too | `STOP` is what the carrier and the regulator recognise whatever the client speaks, so translating them would invent an opt-out vocabulary the network below does not honour. `PARAR` is honoured anyway, because a client who types it means it and the practice can act where the carrier will not — half regulation, half courtesy, and the asymmetry is the honest shape |
| The client's door is translated with the message, and the intake forms are not | A Spanish reminder linking to two English buttons is a loop the client cannot complete, and the fee rests on them completing it. The forms stop at the line where copy becomes clinical instrument: a screener's wording is validated per language and a mistranslated item changes what the score means, which is not a task for somebody who cannot validate it |
| Seeded language is derived from the client number, not rolled | The previous phase's handoff recorded that one extra `chance()` call in the client block moves the whole stream and breaks metrics unrelated to the change. Deriving it costs nothing and leaves every prior figure byte-identical — a handoff note is worth reading before it is worth rediscovering |
| The client's door may narrow the cadence and may never touch the channel | A leaked link leaving somebody on one reminder instead of three is strictly less harmful than one cancelling their session, which this door already does — and it stays fee-eligible, logged with the client as the actor, and visible on the door. `reminderPreference: 'none'` is the other side of the line: it ends the messages and the fee together, so a forwarded link reaching it would silence somebody in a way nothing notices. The boundary is a matrix cell rather than a check the door remembers |
| `reminder_cadence` is its own resource rather than a use of `client` | "A token may update the client record" would be a broader statement than the truth, and a matrix that overstates is the thing this file exists to refuse. It costs 42 cells, every new denial asserted |
| Turning a client's messages off stopped being a one-way door | The cadence form only rendered for a client who was *not* on `none`, so setting somebody there — by seed, by import, or by their own STOP — put them where no screen could bring them back from. The fix needed the fields validated one at a time: a form demanding a cadence would silently drop the submission that turns the messages back on, because that form cannot carry one |
| The README's screenshot pass is a design review, not a documentation chore | Capturing the client's door in Spanish is what showed two identically-worded reason pickers stacked under one appointment, one of them attached to a cancellation with a fee on it. Nothing in the suite could have caught that — every spec passed, and the page was still asking the same question twice with no way to tell which answer went where |
| The cadence is a script and a function, with no scheduler dependency | Due times derive from `startAt` and the injected clock, so the job is idempotent and the schedule is an implementation detail of whatever calls it — cron, a timer, a hosted trigger, or a person typing `npm run reminders:run`. A missed hour costs lateness and nothing else, and the whole five-day cadence runs in a test in a millisecond because the clock is an argument |

## What this project deliberately is not

It is a learning project on synthetic data. It applies HIPAA-inspired principles
because they are good engineering discipline, and it is not HIPAA-compliant
software. There is no authentication — the dev switcher is the seam where it
would go, and *authorization* is the part built for real. There is no insurance
billing beyond the superbill the client claims with themselves, no video, no
diagnosis coding, and no clinician logs in from anywhere it can verify.

Screener trends and the client portal were the two things this write-up
originally listed as deliberate omissions, on the grounds that both are design
problems before they are engineering ones. They still are — which turned out to
be the argument for building them carefully rather than the argument for leaving
them out. The trend refuses to draw a line across a scoring revision or to call
a falling number recovery; the portal has no text box. Neither restraint would
have been discovered by continuing not to build them.
