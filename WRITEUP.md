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
10. **The non-response fee** — an automatic charge, and the four separate
   things that stop it reaching somebody who does not deserve it.
11. **The three P1s** — the phone call the fee depends on, the message volume
   the loop creates, and an inbound channel designed around forgetting.
12. **The second language** — a control that reports success while doing
   nothing, and the door behind the message it was sent in.
13. **The inquiry stage** — a verb narrow enough to be safe, in a codebase
   where nothing had ever been deletable.

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

**Test approach.** All 455 cells are enumerated and asserted, but the expected
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

## 10. The non-response fee

This is the only place in Clearpath where software takes money with no person in
the loop, and almost all of the work was in the guards rather than in the rule.
The rule itself is four lines: at `startAt + graceMinutes`, an appointment still
sitting at `confirmation = 'pending'` becomes `no_response`, and if it is also
still `scheduled` it becomes `no_show` and takes the fee.

**Two functions sharing nothing.** The send cadence and the non-response sweep
were the obvious candidates for one job with two branches — same domain, same
settings, same clock. They are separate modules and separate npm scripts because
they are due at different times, fail in different ways, and only one of them can
bill somebody. `nonresponse:run` can be stopped without stopping the reminders,
which is what a practice reviewing its client agreement will actually want.

**Silence is recorded unconditionally; only the money is gated.** Four
independent things can stop the charge — the appointment is not at `scheduled`,
the client became unreachable, `autoNoShowOnNoResponse` is off, or the
`confirmation` was never `pending` to begin with — and none of them stop the
`no_response` write. That is deliberate: the communication fact is the evidence.
A practice that turns the money off still gets the whole loop, and a practice
that turns it back on has a quarter of data about what non-response actually
predicted.

**The check-in always wins.** The sweep touches `status` only from `scheduled`,
so a client marked `arrived` at five past — or mid-session, or already completed
— is untouchable. The spec that matters is the one where a client answers
nothing, walks in, and is charged the session fee and nothing more. Without the
two-field split that row would have needed no code at all to go wrong.

**The eligibility rule is asked again at the moment of charging.** The horizon
only looks forward, so a client who switched to `reminderPreference: 'none'`
after their last reminder went out is never pulled back to `not_required` by it.
The sweep is the last place that safety setting can still bite, so it calls
`confirmationRequired` before it charges — the same pure function the send path
asks. Recording the silence is not gated on it; only the fee is.

**`noShowFeeCents` shipped changing nothing.** It defaults to `9000`, identical
to `lateCancelFeeCents`, so the migration and the policy change are reviewable
separately and a regression spec pins the old numbers on both sides of the
change. A practice charging 50% for a late cancel and 100% for a no-show is
ordinary, and one field could not say both.

**The waiver ships in the same commit as the charge.** An automatic charge with
no reversal is not shippable, and the reversal is not front desk's — they take
the phone call, but deciding not to charge is a management decision. That was
already a comment in `lifecycle.ts`; `fee: waive` in the matrix is what makes it
true, and the front-desk attempt is a 403 with a row in the audit log. The waiver
zeroes the fee and touches neither `status` nor `confirmation`: the client still
did not turn up, and the practice chose not to charge. The original amount rides
in the audit row's reason code (`client_disputed:9000`) rather than being
overwritten out of existence — and that table is append-only by a database rule,
so the waiver cannot erase what it reversed.

**A second structural lint, because this one has money attached.** Everything
above tests the sweep that exists. `no_response` is the only confirmation value a
fee can be derived from, so the lint is a grep over `src/` and `app/`: write that
value, and you name `confirmationRequired` in the same module. It fails on a
planted violation, verified by planting one. It exists for the batch job somebody
writes next month that sets `no_response` from a query of its own — every
behavioural spec in the suite would still pass, because none of them call it.

**What it did not do, until §13.** The fee's precondition was an `OutboxMessage`
row, which proves the practice *intended* to ask. Nothing sends, so nothing
proved it arrived — the single biggest honesty upgrade the feature had available,
and the one it has since taken. The policy may also simply be the wrong product: in counseling, not answering
messages correlates with the reason for attending, so this fee falls hardest on
the clients least able to answer. That is a clinical decision rather than an
engineering one, and the settings page says so beside the switch.


## 11. The three P1s: the phone call, the volume, and the words

The P0 loop asks, waits, and charges. These three are what a practice actually
runs into once it does — nobody was rung, everybody was over-messaged, and
somebody replied in words to a system that only understood taps.

### The work list has to carry a phone number

The whole fee argument rests on the practice having given the client a chance to
answer. That argument is only honest if somebody at the front desk can see who
has not, in time to ring them — so `unconfirmedSoon` is sessions starting in the
next 48 hours that nobody has answered about, soonest first, **with the number on
the row**. A work list you have to click through twice to act on is a work list
nobody works.

The filter is `confirmation` NOT `confirmed`, rather than `pending`. Three
different silences turn out to be the same phone call: the client nobody could
ask (`not_required` — on `reminderPreference: 'none'`, or booked inside the grace
window), the client who was asked and has not answered (`pending`), and the
client who said no in a way that could not free the room (`declined` on a session
still standing, which is what a keyword decline leaves behind). Narrowing to
`pending` would have hidden precisely the clients most likely not to turn up.
`status: 'scheduled'` is what keeps it short — an hour front desk already marked
confirmed by hand is an hour somebody has already spoken to them about.

No new matrix row. Front desk reads it under the `appointment` read they already
have, so the 546-cell coverage assertion did not move.

### The cap, and what it is not allowed to touch

A weekly client receives three messages a week, indefinitely. Seventy of them is
~11,000 messages a year, and the failure mode is not the bill — it is the
reminder becoming wallpaper, which degrades the one signal the fee is derived
from. So after `confirmationStreakCap` consecutive confirmations (default 4) a
client is asked once, the day before, until they miss one.

`cadenceStages(recent, cap)` is pure and sits beside the other two confirmation
rules, so a four-week track record is a test that runs in a millisecond. It
composes rather than overrides: `dueStages` gained an `allowed` set, not a
branch, so every rule that applied before still applies. The cap can take
messages away and cannot move one earlier.

The thing it deliberately does not touch is the promotion to `pending`. Fewer
messages is still a message, so a capped client's silence rests on exactly the
same `OutboxMessage` row as anybody else's — the fee's evidence was never the
count. Three smaller decisions carry their own comments: only *decided*
appointments move the streak (so a client on `none`, who can never confirm
anything, does not read as permanently unreliable); only *past* ones (or a client
could mute their own reminders by answering early); and a miss of either kind
lifts the cap immediately, because a streak is answering, not agreeing.

### Words, and how little the system is allowed to keep

D-03 chose a tokenized link over a `YES`/`NO` keyword and that choice stands. But
a client who texts back anyway should be understood rather than met with silence,
so P1-3 classifies an inbound body as `confirm | decline | unparsed` and **stores
only the classification**. There is no body column. `classifyInbound` is the only
function in the codebase that ever sees the words, they live for exactly one
expression, and `InboundReply` has nowhere to put a sentence.

**The classifier is strict on purpose.** Whole-message exact matches after
normalising, not "starts with yes". `no I cannot come, my mother died last night`
begins with a keyword and is not a keyword reply — it is a person telling their
practice something, and a substring rule would classify it, cancel a session on
it, and drop the rest on the floor with nobody told. The cost of the strictness
is a polite `yes thanks` reaching a clinician who did not need it. That is not a
close call.

**A keyword decline records the answer and cancels nothing.** This is the
decision the feature turns on, and it came from asking what the sender actually
proves. A portal link carries 24 random bytes and shows the fee before it
applies; a phone number is public and spoofable. So an inbound keyword may write
an answer and may never move money — which means the worst a forged `NO`
achieves is a phone call the client was going to get anyway. It also happens to
be *less* code than the alternative: no window logic, no interstitial, no second
cancellation path. The declined-but-standing hour lands on the front-desk list
from the previous section, which is why that list filters on "not confirmed"
rather than on "pending".

**A shared phone is treated as nobody's phone.** A couple, a parent and a
teenager, a carer — one number, two records is ordinary here. Confirming the
wrong person's hour is the mild version; an `unparsed` from a shared line would
raise an alert about the wrong client to the wrong clinician, which is a
disclosure. Two matches is handled identically to zero.

**The auto-reply is the one message allowed to name an outside service's
number, and it names it in digits.** An `unparsed` reply has to leave the sender
a route to help, and it arrives on a lock screen somebody else may be holding. So
it gives the practice's line and 988 — and *not* the name of the line, because
988 is the Suicide & Crisis Lifeline and both of those words are on the messaging
deny-list. Correctly: the safest possible message would fail its own send if it
named the service it points at. That tension is the clearest evidence the
deny-list is doing real work rather than decorating a template.

**Front desk learns "call them", the clinician learns "they wrote".** The alert
goes to the treating clinician alone (hard rule 9) carrying the reason code
`inbound:unparsed` and nothing else. The audit row carries the same code. Front
desk gets a name, a number, and a button that says *Called them*.

**Checked by looking, not by trusting.** The behavioural spec plants a
distinctive sentence and then hunts for it in every column it could have reached
— the outbox it triggered, the audit row that recorded it, the alert that routed
it, the appointment it was about. The structural half is the one that matters
next month: a migration adding a `body` column "just for debugging" would pass
every behavioural test, because none of them would write to it. So the lint reads
the model out of `schema.prisma` and asserts that its only `String` fields are
identifiers. The same discipline as the author-only, `no_show` and `no_response`
rules.

**It is a command, not an HTTP route.** The PRD says "simulated inbound
endpoint"; what shipped is `receiveInbound()` plus `npm run inbound:simulate`. An
unauthenticated public POST that writes to a client's record needs a provider
signature to verify, and a signature nobody issues is a security control that
only looks like one. The rest of the system is honest about nothing being sent;
this is honest about nothing being received.

**What it still does not do.** Carrier opt-out keywords (`STOP`, `UNSUBSCRIBE`)
classify as `unparsed` and reach a person, rather than silently setting
`reminderPreference: 'none'`. That is deliberate for a simulation — real opt-out
is enforced by the carrier and the provider above this layer, and a half-built
version here would read as compliance without being it. The sender match is also
a scan over clients with a phone, compared in JS: fine for one practice, and it
wants a stored normalised-number column before it is anything larger.


## 12. The last two P1s: what the loop actually did, and why nobody says why

### Which permission cell a report reads under is the design

The confirmation-rate report was the smallest-looking item on the list and the
one with a real decision in it. A confirmation *rate* — "62% of the hours we
asked about got an answer" — is operational. Front desk could see that number
without learning anything they do not already know from the calendar, and an
argument for putting it under `appointment`, which they can read, is easy to
make.

What was actually being built is not that. It is a per-clinician breakdown of
which caseloads go silent, carrying the fee total the policy generated from that
silence. Both halves are things `attendance_history` exists to keep away from
the front desk: `attendanceSummary` is already gated there with a comment saying
a no-show count is a clinical-adjacent pattern rather than a scheduling fact,
and a per-clinician version of the same pattern is not less so for being
aggregated.

So the rule the report is written under, stated once because it will come up
again: **the guard goes on the strictest thing in the payload, not on the name
of the feature.** `confirmationReport` reads under `attendance_history`, the
same cell as the utilisation report beside it on the same page, and front desk
gets a `Forbidden` with the denial on the record. The alternative — a second,
front-desk-visible variant with the money and the clinician split removed — is a
second query, a second permission story and a second thing to keep in sync, for
a number nobody has asked for yet.

The rate itself is the other decision. It is `confirmed / (confirmed + declined
+ no_response)`, not `confirmed / booked`. Dividing by everything booked would
fold in the hours the practice never asked about, which means a client on
`reminderPreference: 'none'` would drag their clinician's number down for
choosing a safety setting — the same category error the fee rule spent the whole
of P0 avoiding, reappearing as a denominator. `pending` is excluded for the same
reason in the other direction: an unanswered question that is still open is not
yet a miss.

And the fee total counts only a `no_response` that became a `no_show`. A late
cancel is charged whether or not anybody was ever asked to confirm, so counting
it here would credit this feature with revenue it did not cause. A waiver zeroes
`chargeFeeCents`, so a reversed fee falls out of the sum with no second
condition — the money line and the `noResponse` count deliberately disagree
after a waiver, because the practice did reverse the charge and the client did
still not answer.

### The reason code that is usually absent, on purpose

Decline reasons reuse the portal's existing four (`cannot_make_it`,
`need_a_different_time`, `prefer_earlier`, `prefer_later`) rather than inventing
a parallel vocabulary. That was the whole of the requirement, and the interesting
part is what reusing them exposed: the portal decline carried no reason at all,
and P1-3's keyword decline — one word arriving by text — can never carry one. So
the item was never "add reason codes to declines". It was "ask for a reason on
the one path that has a form to ask on".

Which makes the column nullable, and makes null the majority. That is the
design, not a gap:

- The portal asks **without requiring an answer**. A required select would put a
  toll on giving an hour back, and the practice wants the hour back more than it
  wants the reason.
- A keyword decline writes null forever. If the column defaulted to
  `cannot_make_it`, every texted "no" would silently become a stated preference
  the client never expressed, and the report would be fiction.
- So `declineReasons` on the report lists only the declines that said something,
  and says in the caption that most do not. A bar labelled "did not say" would
  swamp the four that mean anything.

Two smaller things fell out of it. The reason is an *annotation*, not a
permission — so the server action drops an unrecognised value rather than
throwing, because a tampered form field must not stand between a client and
cancelling their appointment. And it rides the same write as the decline it
explains, through the `declineReason` option on `setStatus` next to the existing
`confirmation` one, so there is no window in which the practice holds the answer
but not the reason for it.

The fee interstitial keeps its own copy of the select rather than carrying the
first tap's choice through the redirect. Threading it would have meant a reason
code in a URL, and the rule about what may appear in a URL is not one to spend
on saving a client one click.


## 13. Queued is not delivered

The fee had a precondition and it was the wrong one.

Everything in §10 rests on the practice having asked. What the code actually
checked was that an `OutboxMessage` row existed — and a queued message is an
intention. It is the practice's own note to itself that it meant to ask. It is
not evidence that a phone ever buzzed.

The gap between those two claims is the practice's own infrastructure, and it
falls entirely on the client. A carrier outage, a dead number, a bounced address
produce a client who is billed for silence they were never given the chance to
break — and who has nothing to point at when they say the message never came,
because the only artifact is a row proving the practice *wanted* to send one.
That is the same failure mode as charging a client on `reminderPreference:
'none'`, arriving by a different route: a fee for not answering a question
nobody asked.

So `OutboxMessage` grew a lifecycle — `queued` → `sent` → `delivered` | `failed`
— and the sweep reads the terminal state rather than the row's existence.

**What did not change is the more important half.** Silence is still recorded
whatever became of the message. `confirmation` is a communication fact and the
sweep writes it unconditionally, exactly as it does for a client who became
unreachable mid-cadence (D-01) or with the auto-transition flag off (D-10).
Delivery is now the fourth independent thing that can stop the charge and the
fourth that cannot stop the write. The evidence is never optional; only the
money is.

Four decisions inside it:

- **One arrival, not three.** A client whose `d5` landed and whose `d0` bounced
  was asked. Requiring every stage to arrive would make the practice's own
  flakiness into a client's exemption, which is the opposite error to the one
  this fixes.
- **`sent` never counts.** It is the practice's record of handing a message
  over — the same class of claim as `queued`, one hop further along. Only a
  receipt is somebody other than the practice saying the message arrived, and
  the whole point is that the evidence should not come from the party doing the
  charging.
- **A terminal receipt does not move.** A carrier reporting `failed` on a
  message it already reported `delivered` is retracting evidence a fee may
  already rest on. The first receipt stands and a human looks at the dispute; a
  webhook is not allowed to quietly un-charge somebody, and it is even less
  allowed to quietly start charging them. Duplicate receipts are a no-op rather
  than an error, because a carrier retrying a webhook is normal.
- **The trail says which silence it was.** An undelivered sweep logs
  `no_response_undelivered`, not `no_response`. It is the row a client disputing
  a charge would need, and the row an auditor would look for when the charge
  everybody expected is missing. A missing fee with no explanation is
  indistinguishable from a bug.

Two structural things came with it. `AppointmentReminder.outboxMessageId` became
a real relation with `onDelete: Restrict`, because a dangling id is precisely
the failure that would silently un-prove the ask — the evidence cannot be
deleted out from under the fee, and the database says so rather than a
convention. And `failureCode` is a code, never a carrier's prose: the same rule
the inbound classifier lives by, for the same reason, since this column is read
by roles that may not open a record.

`npm run delivery:run` is the carrier that does not exist. Two steps rather than
one — hand over, then hear back — because the gap between them is the entire
feature. A real integration replaces the first half with an API call and the
second with a signed webhook, and until it does, that script is the only thing
that can move a message to `delivered`. Which is deliberate: the fee depends on
that state, so nothing should reach it by accident. The stub always succeeds,
because a stub inventing random failures would make the seeded fee totals
unreproducible, and a fixture that only probably exists is a spec that only
probably means anything. The failure path is a seeded fixture instead — one
client in the quarter, three messages, three `failed` receipts, `no_response`
and `no_show` on the record and nothing charged. It is the only row in the
quarter where those three sit together.

The visible cost is that the quarter's fee from silence fell from $270 to $180.
That is the feature working: one of those charges was for a message that never
arrived.


## 14. The hour the record already knew was free

The waitlist could always answer "who wants a Tuesday at three." What it could
not answer was *which* Tuesday at three was going spare — so the work-list page
asked it about tomorrow at 15:00, hardcoded, whether or not anything had freed
up then. A matcher with nothing to match against is a feature in the shape of a
demo.

The answer was already in the record twice over, written by two different parts
of the system that had never been introduced:

- A **cancellation** frees the hour outright. The row keeps its `startAt`, so a
  future `cancelled` or `late_cancelled` appointment *is* an empty slot with a
  clinician and a room attached.
- A **decline** is the other half, and it is the one §11 earned. A client who
  taps "I can't make this" in the portal, or texts back `can't make it`, has
  told the practice they are not coming. At `d5` that is five days' notice —
  the longest warning this system ever receives about an empty room.

So `waitlistOpenings` is a join, not a new fact: every appointment in the next
30 days that is free or about to be, each carrying the waitlist entries whose
stated weekday and time window fit that hour.

### The two are shown together and labelled apart

They are not the same offer, and merging them would be the bug.

A cancelled hour is free. A declined one is **still on the books** — because
`messaging/inbound.ts` will record an answer and will never move a session:
a caller ID is not a credential, and the fee disclosure the portal shows before
a late cancel cannot be shown in a text. The hour stays scheduled until a human
rings the client and cancels it properly.

That makes a declined opening two calls, not one — the client first, then the
person you are offering it to. A list that rendered both as "free" would
eventually put a client in a room somebody else was still booked into, and the
person who arrives to find their room taken had done nothing wrong: they said
"I can't make it" to a text message.

### Small things that are not small

- **A client is never offered the hour they just gave back.** Someone on the
  waitlist who declines their own Tuesday would otherwise match their own
  opening perfectly, which is the most confident wrong row a list can show.
- **One query for the entries, not one per opening.** The matching rule is
  pure and cheap; the round trips are not. Same predicate now serves both
  `waitlistMatches` and `waitlistOpenings`, so the two surfaces cannot drift
  into disagreeing about what "fits."
- **Two audit rows, not one.** The list reads appointments *and* client
  records, so it goes through `guardedAll` and says both — one nested pair in
  one transaction, rather than one row that under-describes what was read.

### What it deliberately does not do

- **It does not book, offer, or message anybody.** Same rule as the matcher it
  is built on: this is a list of phone calls. An automatic offer would put a
  client in a room with a clinician neither of them chose for that hour, and
  would do it from a decline that a forged text could have produced.
- **It does not filter by notice.** A four-hour opening is worth less than a
  five-day one, so the notice is shown and the list is sorted by start time —
  but "too short to bother with" is a front-desk judgement, not a constant.
- **It does not check the candidate's clinician against the opening's.** A
  waitlisted client of a different therapist appears against this hour, and
  whether that is an offer at all is a clinical question about caseloads and
  continuity, not one a filter should silently answer.


## 15. Two reductions, and the one that must not stack

The cadence already had a way to send fewer messages: the streak cap in §11.
Confirm four times running and the practice stops asking five days out, because
a client who always answers does not need three questions. What it had no way to
express is the other direction — a client who says, at intake or on the phone,
"just tell me on the day."

The field is `Client.reminderStages`, an empty-by-default list of the same three
stages the rule already speaks in. Empty is the normal state and means *the
practice cadence*, cap and all; a non-empty list is the client's own answer.
There is no second "use custom cadence" flag, for the same reason the cap is off
at a value of zero rather than behind its own boolean: two fields that can
disagree is a bug waiting for somebody to only update one of them.

### The bug worth naming is the one that would have arrived four weeks late

The obvious implementation intersects. The client picked `d0`; the streak cap
says `d1`; take what they have in common and you get **nothing at all**.

A client who asked for *fewer* messages ends up with none — and not on the day
somebody ticked the box, which is when it would have been noticed. It arrives
four confirmations later, silently, on a client whose entire distinguishing
feature is that they reliably answer. They then stop being asked, stop
confirming, and the sweep that reads silence has no message behind it to read.

So a selection **wins outright** rather than narrowing further. The cap is an
automatic reduction the system applies on the client's behalf; the selection is
the client having already answered that question themselves. Applying both is
answering it twice.

### What it is still not allowed to do

The selection narrows. It cannot promote, and everything downstream of it is
unchanged:

- **`dueStages` still applies every rule it applied before.** A `d5`-only client
  booked three days out gets no message, exactly as before — the stage still has
  to fall after the booking and before now. The selection can take a message
  away; it can never move one earlier.
- **`reminderPreference: 'none'` still outranks it.** A selection is *which*
  stages, never *whether* — the do-not-message setting is checked first and the
  checkboxes do not render for a client on it.
- **The fee rests on exactly the same evidence.** Where a selection queues
  something, the appointment is still promoted to `pending` with an outbox row
  behind it, and a delivery receipt is still what a charge requires. Fewer
  messages is still a message.

A `d0`-only client is therefore askable on three hours' notice and chargeable
for silence on the same evidence as anybody else. That is the practice's call to
make per client and it is now visible on the record, which is the improvement
over it being unavailable and therefore never discussed.

The seed carries the pair deliberately: TC-051 confirms four times and is capped
to the day before, TC-056 confirms four times *and* chose the day of — same
history, different cadence, and the second one is the row that would have gone
silent under an intersection.

## 16. A second language, and the control that quietly stops working

The last open item on the confirmation PRD was "multi-language message bodies,"
and it was on the list with a parenthesis attached: *the deny-list is
English-only and would need one per language*. That parenthesis is the whole
feature. Everything else here is six strings translated twice.

`assertDiscreet` is the reason a reminder can go to a lock screen at all. It
refuses any client-facing body containing `therapy`, `counseling`, `anxiety`,
`intake` — thirty-odd stems that would tell a roommate what the appointment is
for. Translate the templates and leave it alone, and `Recordatorio: su terapia
es el martes` passes it. Not partially. Completely, and quietly: the send
succeeds, the row is written, the message goes out, and the control that exists
to prevent exactly that disclosure reports success while doing nothing.

That is worse than having no gate. A missing check is visible in review; a check
that passes everything looks like a check.

### So a language is not a translation, it is a pair

`Language` is one type used twice: `Record<Language, Record<TemplateKey, Build>>`
for the bodies, `Record<Language, readonly string[]>` for the terms. Adding
`pt` does not compile until it answers for all six templates, and does not pass
its tests until `DENY_LISTS` answers for it too. The coupling is the design —
there is no arrangement of this code where the templates ship and the terms are
a follow-up ticket.

The gate then reads **every language's list against every body**, not the
client's own. Three reasons, and the third is the one that matters:

- A body is routinely a mix — a Spanish template wrapped around an English
  practice name, an English template with one Spanish word left in it.
- The language a message is *read* in is not a fact this system holds. `Client.language`
  is a preference about what the practice writes, not a property of the reader.
- Checking all of them means **adding a language can never weaken the gate for
  the ones already shipping**. A per-language check would make every new
  language a chance to regress the old ones.

It costs a few dozen `includes` calls per send.

### The bug underneath both halves was the same three characters

`'Depresión'.toLowerCase()` is `'depresión'`, which does not contain
`'depresion'`. A case-folding gate passes the accented spelling of every term on
the list — which is the only spelling anyone actually writes. So `fold()`
normalises to NFD, drops the combining marks, and lowercases; terms are stored
in that same folded form, and a test asserts it, because a term carrying an
accent is a term that silently matches nothing.

The inbound classifier had the mirror of it. `normalise` collapses everything
outside `a-z`, so an unfolded `sí` arrives as `s` — not a phrase, therefore
`unparsed`, therefore an alert to a clinician and a phone call, **every single
time a Spanish-speaking client says yes**. Same three characters, opposite
consequence: the outbound bug sends what it should have stopped, the inbound bug
escalates what it should have understood. One `fold()`, exported from the
messaging module and used by both.

### The inbound table is language-blind on purpose

There is one phrase table, the union of every language's, and no attempt to pick
a table per sender. An inbound message does not arrive with a language on it;
the client's stored preference is about what the practice writes; and a
bilingual client answers in whichever one their thumb reaches first. Guessing
here buys nothing and can only be wrong.

The union is safe **only while no phrase means opposite things in two
languages** — which is a property of the data, not of the code, so a test
asserts it rather than a comment hoping for it. `no` is decline in both. `ok` is
confirm in both. When a third language eventually breaks the invariant the build
says so, and the fix is to delete the ambiguous phrase from both tables and let
it fall to `unparsed` — which is a person ringing the client, the answer that
file defaults to whenever it is unsure.

### The crisis line, twice

The English auto-reply names 988 as digits rather than as the Suicide & Crisis
Lifeline, because both of those words are deny-listed — correctly — and the
safest message the practice sends would otherwise fail its own send. The Spanish
one is under the identical constraint, `crisis` being spelled the same in both
lists, and takes the identical way out. `ayuda urgente` is the most either body
will say about why somebody might dial it.

### What it deliberately does not do

- ~~**The portal is not translated.**~~ Scope was message bodies, and the portal
  is a page behind a link with its own layout, fee disclosure and consent copy.
  Half a translation is worse than none: a Spanish reminder landing on an English
  fee disclosure is the one screen where comprehension is legally load-bearing.
  *Done in §17, which is that sentence taken at its word.*
- **No language detection.** Not on inbound, not on intake. `Client.language` is
  set by a person who asked the client, which is the only way it is ever right.
- **No per-message override.** A client is written in one language.
- **The deny-lists are not machine-translated.** They are stems chosen against
  the English list's intent — `psicolog` covering `psicólogo`, `psicóloga`,
  `psicológica` — and a machine translation of a word list produces plausible
  entries nobody has checked, on the one control that has no second layer behind
  it.

## 17. The door in the language the message was written in

The previous item translated what the practice *sends*. What it sends is a link,
and behind the link was a page written entirely in English: a greeting, a
schedule, four reasons to change an appointment, three forms, and one sentence
saying that cancelling now costs ninety dollars. So the feature as shipped was a
Spanish reminder that opened an English document — which is not a partly-finished
translation, it is a client agreeing to a fee they were never shown in a language
they read.

### The rule was already written; two of its three layers could not enforce it

`Record<Language, ...>` over `CLIENT_TEMPLATES` and `DENY_LISTS` is the whole
control from §16: a new language does not compile until it answers for every
body, and does not pass its tests until the terms answer for it too. Extending
that to the portal splits into three layers, and only the first gets the same
guarantee.

**Page copy is code, so the compiler still does it.** `src/strings.ts` is one
`Record<Language, Strings>` holding every string on both tokenized doors —
headings, buttons, notices, the fee sentence, and the error copy. A missing key
is a build failure, exactly as before.

What the compiler cannot see is a value that was *copied* rather than
translated: `es: 'Keep the appointment'` typechecks perfectly and is the failure
this whole item exists to prevent. So the test walks both trees and asserts no
key holds the same string in both — which found precisely one true collision,
`No`, and it is listed by name rather than waved through by a looser assertion.
The same discipline `crisis` needed on the deny-list.

**Form questions are data, so nothing can.** A form template is a database row,
because the point is that a practice manager revises an intake without a deploy.
`FieldDef.label` became `Record<Language, string>`, but that type only describes
the shape a row *ought* to have — no compiler runs when somebody types a question
into a form and hits publish.

What replaces it is `missingLanguages`, consulted where the form is **sent**
rather than where it is rendered:

```ts
const untranslated = missingLanguages(asSchema(template.schema))[client.language];
if (untranslated.length) throw new Conflict(..., 'template_not_translated');
```

That is the same choice `assertDiscreet` makes, for the same reason. A gate at
render time protects nobody, because by then the link has gone out and the client
is looking at the blanks. A gate at send time is a practice manager holding a
list of field keys. And the editor now shows both boxes per question with the
empty one outlined in red — the missing half is visible before it is a refusal.

The tempting shortcut here is the dangerous one: falling back to the English when
the Spanish is empty. That produces a template that passes every gate, sends
without complaint, and puts English questions in front of a Spanish-speaking
client — the §16 failure exactly, one layer up. An empty string is kept as empty
on purpose.

### The migration is the reason it could not be a reseed

Existing `FormTemplate` rows held bare strings. Reseeding would publish new
versions and leave the old ones untouched — and a submission renders against the
version it was answered on, so every historical submission would have lost its
labels. That is precisely the failure template versioning exists to prevent, so
the change is a data migration that rewrites old versions in place, converting
`"label"` to `{"en": "label", "es": ""}`.

The Spanish half is written **empty, not copied**. Nobody has translated those
rows, so the honest state is the one where `issueForm` refuses to send them to a
Spanish-speaking client. Copying the English across would have made every
historical template silently sendable and wrong.

### One instrument, two readings — which is what buys the whole design

The alternative shape was a second `FormTemplate` per language. It fails in three
places at once: a client who switches language forks their score history across
two template keys, so `trends` draws a line through two different instruments;
the scoring rules have to be kept identical by hand; and a clinician who does not
read Spanish opens a Spanish submission.

Keeping labels inside one version fixes all three by accident, because **a
submission stores values, not labels**. A Spanish client picking *Casi todos los
días* stores `3`. The therapist opens it and reads *Nearly every day*, against
the same version, with no translation happening at read time and no second key
to reconcile. `STAFF_LANGUAGE` is a constant, and it is allowed to be one.

The exception is free text, which stays in the client's own words. Machine-
translating what somebody wrote about their own life into the clinical record is
a worse answer than a clinician knowing they need an interpreter.

### Two things the second language turned from untidy into a bug

**The service's error message was reaching the client.** `submit` returned
`{ error: e.message }`, and `e.message` is written for a log — it names template
keys and versions, and it is English whatever the client reads. It now returns
the `Conflict`'s code, the words are chosen in the client's language, and any
code the door was not designed to explain becomes `unknown` rather than leaking
an internal name onto a client's screen.

**Money had a locale in it.** `money()` is hardcoded to `en-US`. The naive fix is
`es-ES`, which renders the late-cancel fee with a euro sign — a currency error
wearing a translation's clothes. `es-US` is correct: a US practice bills a US
client in dollars whichever language it explains them in. There is a test, because
the failure is silent and the number is the one the client is agreeing to.

### The screen whose reader is unknown

A dead token resolves nobody — that is what makes it dead — so *"This link has
expired"* has no `Client.language` to read. Defaulting to English would put the
practice's least helpful screen in front of exactly the client least able to act
on it. Both error pages render in every language, stacked, each in its own `lang`
element. Two short paragraphs, and cheaper than querying an expired token purely
to learn what language to apologise in.

### What it deliberately does not do

- **Staff pages are not translated.** The practice works in one language, and
  `STAFF_LANGUAGE` is a constant naming that assumption rather than hiding it.
  Translating them is a different feature with a different argument.
- **No language switcher on the door.** `Client.language` is what the practice
  recorded a person asking for; a toggle would let a shared phone's previous
  reader change it, and would make the *sent* message and the *opened* page
  disagree.
- **The template `name` column stays English.** It is how staff pick a template
  out of a list; the client-facing heading is `schema.title`, which is a pair.
- **No `Intl.DateTimeFormat` for dates.** The weekday is translated and the time
  stays `HH:MM`, which is what the practice's own clock says everywhere else.
  Localizing the *format* is a separate decision from localizing the words.


## 18. Naming the power before building it

*Phase 1 of `prd-intake-inquiry.md`. Pure logic only: the permission cells and
the state machine. The table, the trigger and the purge are Phase 2.*

Clearpath had no shape for a person who rang once. `Client.dateOfBirth`,
`Client.treatingClinicianId` and `Client.code` are all required, so the first
row the practice can create about a caller already asserts three things nobody
knows on a first phone call. And roughly half of inquiries go nowhere — which,
in a system where audit rows are append-only by trigger and notes are frozen by
trigger, turns every unanswered voicemail into a permanent record of somebody
who never consented to being a client.

So this feature needs something nothing else in the codebase has: a delete.

### The verb comes before the mechanism

The instinct was to build the table first and decide the permission afterwards.
Doing it the other way round is what the TDD ordering in `CLAUDE.md` is for, and
here it changed the design rather than just the sequence.

`Action` gains `discard`, not `delete`. `permissions.ts` already makes this
argument once — `waive` is its own action rather than an `update` on `fee`,
because *a power nobody named is a power nobody reviewed*. `delete` would have
been the generic version of that mistake: a verb sitting in `ACTIONS` that a
later reviewer, adding a resource, would reach for on a table that must never
lose a row. `discard` applies to exactly one resource and reads wrong anywhere
else, which is a design constraint the type system enforces for free.

`Resource` gains `inquiry`. Twenty-eight new cells across seven roles, and the
interesting ones are the denials:

- **Clinicians read and create, and do not discard.** A therapist who takes
  their own call should be able to write it down, and an inquiry naming a
  requested clinician is a capacity question that clinician answers. But
  recording a call is clerical; declaring one dead is an operations decision,
  and it is the one that destroys a row ninety days later.
- **Break-glass does not appear in the row at all.** Every admin cell is
  `always`. That is not laziness — a `breakGlass` rule anywhere in this row
  would imply an inquiry holds something clinical worth breaking glass *for*,
  and the whole reason this row is deletable is that it does not. A test asserts
  no admin `inquiry` cell resolves to `breakGlass`, so the absence is a
  statement rather than an omission.
- **Auditor and client get nothing**, which the matrix's existing sweeps already
  enforce: the auditor test walks every resource but `audit_log`, and the client
  test walks every cell but its one.

The coverage assertion is what makes this hold. `permissions.test.ts` probes
every role × resource × action against a policy written from the PRD rather than
read back off the matrix, three times each — as an insider holding every
relationship, as a supervisor, and as a stranger. Adding one action and one
resource took the suite from 1616 tests to 1907 without a line of new
scaffolding, because the denials were never optional.

### Two endings, both terminal

`src/clients/inquiry.ts` is `open → converted | discarded`, in the shape of
`scheduling/lifecycle.ts` per hard rule 8. Nothing returns to `open`, and the
two endings do not connect.

They are terminal for different reasons, which is worth saying out loud. A
converted inquiry has produced a `Client` with its own history hanging off it.
A discarded one is counting down a retention window towards being destroyed —
so `discarded → converted` is not merely a wrong status, it is a row the purge
sweep is still aiming at while the practice believes it has a client. An illegal
move raises `Conflict`, never a silent no-op, for exactly that reason.

### What this phase deliberately does not do

- **No table.** The schema is untouched. `AuditEvent.action` and `.resource` are
  already `String` columns, so `discard` and `inquiry` needed no migration —
  which is the first hint that the audit trail was built to outlive the rows it
  describes.
- **No discard reason codes yet.** They land with the write path in Phase 2,
  where there is something to write them onto.
- **The trigger is not asserted here, because it cannot be.** The database rule
  refusing a `DELETE` of a non-`discarded` inquiry is the actual safety property,
  and a mocked test of it proves nothing. It is asserted against a real
  connection in Phase 2 or it is not asserted.


## 19. The first row that can be destroyed

*Phase 2 of `prd-intake-inquiry.md`: the table, the reason codes, the database
rule, and the sweep. The verb was named in §18; this is the mechanism under it.*

### What makes a row deletable

`Inquiry` is its own model. The cheaper answer was a `Client` with nullable
`dateOfBirth` and `treatingClinicianId` plus a `ClientStatus.inquiry`, and it
would have inherited the waitlist, the forms, the outbox and the portal for
nothing. It was rejected on one point: it requires pointing a `DELETE` at the
foreign-key root of every clinical table in the schema. A retention sweep aimed
at `Client` is a sweep that can reach a progress note, and no amount of `WHERE
status = 'inquiry'` makes that a comfortable thing to have written.

So the deletable table is a separate one, and it is deletable *because* of what
it does not have. No `dateOfBirth`, no `code`, no `treatingClinicianId` —
conversion is what those are for. No relation, in either direction, to
`ProgressNote`, `ProcessNote`, `FormRequest`, `FormSubmission`, `Alert`,
`Appointment`, `PortalLink` or `OutboxMessage`. Nothing is ever sent to an
inquiry, which is D-05 and also why there is no outbox relation to argue about:
a message to a number somebody left on a voicemail is a disclosure to whoever
else holds that phone.

"There is no column" is only true until somebody adds one, so it is a test
rather than a comment. One assertion reads the model blocks out of
`schema.prisma` and fails if `Inquiry` names any of those eight, or if any of
them names `Inquiry`. A second scans `src/` and `app/` for a query on an
inquiry that mentions a clinical delegate, or a clinical query that mentions an
inquiry — the same structural technique as the author-only rule in
`notes/service.test.ts`, whose helpers it now shares. Both are cheap and neither
can be satisfied by a behavioural test, because the code that would break them
has not been written yet.

### What the database refuses

The window is policy: `PracticeSettings.inquiryRetentionDays`, ninety days,
changeable by the practice because the right number is a legal question. The
invariant is not policy, so it is not in the application:

```sql
CREATE TRIGGER "inquiry_no_delete_unless_discarded" BEFORE DELETE ON "Inquiry"
  FOR EACH ROW EXECUTE FUNCTION "inquiry_delete_only_discarded"();
```

It lives in the migration beside `audit_append_only` and
`progress_note_content_frozen`, and it is deliberately written in their register,
because hard rule 5's principle generalises: an invariant that matters is
enforced by the database, not by convention. The sweep is careful today. The
question a trigger answers is what happens when the next thing to call
`inquiry.delete()` is not.

A converted inquiry is refused by the same rule with no branch of its own — it
is part of a client's history now, and `status <> 'discarded'` already says so.
The tests assert both refusals against a real connection, which is the only way
this property can be asserted at all: a mocked `delete` proves the application
does not delete an open inquiry, and the application was never the threat.

One more thing the database holds, which the state machine also holds and which
only the database holds *permanently*:

```sql
CHECK (("status" = 'discarded') = ("discardedAt" IS NOT NULL AND "discardReason" IS NOT NULL))
```

A discarded row with no `discardedAt` is invisible to the sweep, which counts
from it. It is a row that is deletable in principle and immortal in practice —
the exact failure this feature exists to refuse, arrived at from the opposite
direction and much harder to notice, because nothing errors and the row simply
stays. The reason code rides the same constraint: a discard the audit log cannot
describe is a discard that did not really happen.

### The two-step, and why it is two

Discard sets a status, a reason code and a timestamp. The purge, ninety days
later, deletes. An immediate hard delete makes a mis-click at 9am unrecoverable
when they ring back at 2pm; a soft delete that never completes is the thing the
whole PRD exists to refuse. The gap between the two is also what makes the
destruction clock-driven, and therefore testable at all — the injected clock
already existed for the late-cancellation window, and a hundred and twenty days
of retention pass in a millisecond.

The sweep is idempotent by construction rather than by a guard: a purged row is
not in the next run's candidate set because it is not anywhere. That is the one
pleasant thing about deletion as an operation.

### What the audit log gives up on purpose

Every inquiry row written here carries `clientId: null`. That column means *a
client record*, and an inquiry is not one — it is `resourceId` that names the
inquiry. The distinction looks pedantic until the purge runs, at which point it
is the whole design: `AuditEvent.clientId` has no foreign key, inquiry ids never
enter it, and so a destroyed inquiry leaves its audit rows standing with nothing
dangling and nothing to cascade.

What an auditor is left with, for a caller who rang once and never came back:

| action | actor | reason | resourceId |
|---|---|---|---|
| `discard` | front desk | `discarded:no_answer` | `cl…` |
| `discard` | `system` | `purged` | `cl…` |

Two rows about a row that no longer exists. The log says an inquiry was created,
was handled, and was destroyed. It never said who it was — no name has ever been
in it, and now there is nothing left to join to. That is not a gap in the trail;
that is what purging is *for*, and it is D-06 written out: the alternative —
blocking the delete to keep the log joinable — is how "deletable" quietly
becomes "undeletable".

The two reasons are two codes rather than one, so a discard and the purge that
eventually follows it are distinguishable to someone reading the log with no
access to anything else.

### What this phase deliberately does not do

- **No conversion.** `Inquiry.clientId` does not exist yet; it lands in Phase 3
  with `convertInquiry`, and adding the column early would have meant a relation
  to `Client` sitting in the schema with nothing writing it.
- **No waitlist.** `WaitlistEntry.inquiryId` and the one deliberate
  `ON DELETE CASCADE` in the schema are Phase 3. A waitlist entry for a person
  who no longer exists is not a thing, but it is not a thing that exists yet
  either.
- **No scheduler.** `runInquiryPurge` takes a clock and returns the ids it
  destroyed. Nothing calls it on a timer, for the same reason nothing sends: the
  scheduled path is a deployment concern this project does not claim.
- **No UI.** Front desk cannot yet record a call. The write path, the refusals
  and the trail are what Phase 2 is for; the screens are Phase 4.


## 20. The nullable foreign key that earns it, and the id decided before the row

*Phase 3 of `prd-intake-inquiry.md`: the waitlist accepts a caller, conversion
happens in one transaction, and the same fact starts living at two sensitivity
tiers.*

### The one nullable FK, and why it is the only one

`WaitlistEntry.clientId` was required. It is now optional, alongside a new
optional `inquiryId`, with a `CHECK` requiring exactly one:

```sql
CHECK (("clientId" IS NULL) <> ("inquiryId" IS NULL))
```

This is the only place the inquiry stage gets a nullable foreign key, and the
reason it earns one here is the reason the whole feature exists: "wants a slot
we do not have" is what *keeps* most inquiries inquiries. A caller asking for
Tuesday evenings is asking for the thing the practice has none of, and making
them a client first — inventing a date of birth and assigning a clinician — in
order to write that down is exactly the invention this stage removes.

Two nullable columns invite two failures, and the constraint refuses both.
Neither set is a row nobody can ring. Both set is worse: it is a row that would
be offered the same hour twice, and that conversion would repoint into a
contradiction. Writing it as an XOR rather than as two application checks is
the same argument as `audit_append_only` and the delete trigger from §19 — an
invariant that matters is enforced by the database.

The constraint was verified against the data before the column that could
violate it existed. Every existing entry belongs to a client, so it holds on day
one — but "holds" is a claim about rows, and a migration that adds a constraint
without looking is a deploy that fails somewhere less convenient than a laptop:

```sql
SELECT count(*) INTO orphans FROM "WaitlistEntry" WHERE "clientId" IS NULL;
IF orphans > 0 THEN RAISE EXCEPTION ...
```

### The schema's only cascade, next to its only DELETE

`WaitlistEntry.inquiryId` is `ON DELETE CASCADE`. It is the only cascade in the
schema, and it sits deliberately next to the only `DELETE` path in it. A
waitlist entry for a person who no longer exists is not a thing, and saying that
in the foreign key is what keeps `runInquiryPurge` from having to know this
table exists at all.

The cascade is not a second delete path. An open inquiry with a waitlist entry
is still refused by the §19 trigger — the cascade only ever fires *after* the
trigger has already agreed the row may go. Both halves are asserted: the purge
destroys the entry with the inquiry, and a raw delete of an open one takes
neither.

Every other relation to `Inquiry` is `RESTRICT`, spelled out rather than left to
Prisma's default. An optional relation defaults to `SetNull`, which for
`WaitlistEntry.client` would leave a row satisfying neither half of the XOR —
the default quietly became wrong the moment the column became nullable.

### Conversion, and the id that exists before the row

`convertInquiry` is one transaction through `guardedAll`: create the `Client`,
set `Inquiry.clientId` and `status = 'converted'` through the state machine,
repoint the waitlist entry, copy `referralSource` and `referralNote` across.

Two authorizations, and **no new matrix cell**. Conversion needs `create` on
`client` and `update` on `inquiry`, and only front desk holds both — a clinician
has neither, and the practice manager reaches a client record only through
break-glass, which does not include creating one. Who may convert therefore
falls out of the existing policy with nothing new to review. That is what a
permission matrix is *for*: the interesting answer was already in the table.

The odd-looking line is this one:

```ts
const clientId = randomUUID();
```

§19's rule was that an audit row about an inquiry carries `clientId: null`,
because that column means *a client record* and an inquiry is not one.
Conversion is the exact moment that stops being true, and both of its audit rows
should name the client. But `guardedAll` authorizes every request before any
work runs — which is the property that makes it worth using — so the requests
are built while the client does not yet exist and cannot be named.

Deciding the id in the application rather than taking the column default is what
closes that. It is a real trade: one client row in this database has a UUID
where the other ninety-seven have cuids. The alternative was to create the row
first and authorize afterwards, which inverts the order the guard exists to
enforce, for a cosmetic gain.

The inquiry row is kept, pointing at the client. That is what makes "how long
from call to first session" answerable, and it is why a converted inquiry is
permanently unpurgeable: the §19 trigger refuses anything that is not
`discarded`, and there is no branch in it about conversion. Both endings are
terminal through the same `TRANSITIONS` table, so a second conversion and a
discard-after-conversion are the same `Conflict`.

Nothing is sent. `convertInquiry` writes no `OutboxMessage` and no
`FormRequest`, and a test asserts both counts are zero. Sending the intake
packet is the caller's next step: `issueForm` refuses a template the client
cannot read in their language (§16), and that refusal has to surface to the
person who clicked rather than get swallowed inside a conversion that already
committed.

### The same fact at two tiers, kept apart on purpose

`Client` gains `referralSource` and `referralNote`. The intake form already asks
"How did you hear about us?" — and that answer is a `FormSubmission`, guarded at
`treatingOrSupervising`. The practice manager who runs the referral report may
not read one.

So the fact is stored twice, deliberately (D-04). Not synced, not reconciled,
not surfaced from one to the other: "keeping them in sync" would mean showing
front desk a clinical submission, which is the leak the whole codebase is built
to avoid. Same fact, two sensitivity tiers, two readings — the same argument
`clients/repository.ts` already makes about one client row read as demographics
and as clinical record.

The failure mode of storing it twice is drift, and it has a specific shape:
options in a form template are *data* and change without a deploy, while the
enum is *schema* and does not. A category the report can produce and the form
cannot is invisible until somebody notices a bar that is always zero. So the
lists are asserted equal:

```ts
expect(Object.values(PrismaReferralSource)).toEqual(referral.options.map((o) => o.value));
```

`Client.referralSource` is nullable rather than defaulted. Null means nobody
asked, which is the honest state for clients created before the column existed;
a default of `other` would enter an answer nobody gave. The seed fills the
ninety-seven from a fixed 30/30/30/10 pattern indexed by client number rather
than a random draw — that loop's PRNG sequence is load-bearing, and adding a
draw to it reshuffles every fixture downstream.

### What this phase deliberately does not do

- **No `/inquiries` screens.** The worklist learned to render an inquiry entry —
  a name, a number, an "inquiry" badge, and no client link, because there is no
  record to open — but recording a call, converting one and the retention
  setting are all Phase 4.
- **No seeded quarter.** The ~40 inquiries the referral report is measured
  against belong with the report (P1-1), not before it.
- **No duplicate check.** "Have we met this person?" is P1-2, and the answer
  lives behind a permission front desk does not have.


## 21. Drawing what the server would allow, and counting the calls that failed

*Phase 4 of `prd-intake-inquiry.md`: the enquiry desk gets a screen, the
retention number gets a sentence, and the referral report gets built from the
calls rather than from the clients.*

### The control that is not drawn

`/inquiries` shows a clinician the list and the create form and no Discard
button. Not disabled, not greyed — absent. The two affordances come from
`may()`:

```ts
const mayDiscard = may({ actor, action: 'discard', resource: 'inquiry' });
const mayConvert = may({ actor, action: 'create', resource: 'client' });
```

The second line is the interesting one. Conversion needed no new matrix cell:
it creates a client, so it is already governed by `create` on `client`, which
only front desk holds. A `convert` action would have been a seventh column on
every role in the matrix and a new set of denial cells to review — for a rule
that already existed and was already tested. Deriving the affordance from the
underlying write is what kept it out.

Both are gated the same way the navigation is, and for the same reason: a
button that is drawn and then refused teaches people that refusals are noise.
`intake.spec.ts` asserts the absence, because `permissions.test.ts` proves the
rule and nothing before this proved the page agreed with it.

### The send is a second act, with its own ending

`convertInquiry` does not send the intake packet, and the page does — as a
separate call whose failure is a separate outcome. `issueForm` refuses a
template the client cannot read in their language (§16), and folding it into
the conversion transaction would have given that refusal two bad options:
abort the conversion for a translation problem, or swallow it. Neither is
what the front desk needs, which is a client record and a sentence saying the
packet is still owed.

So both endings return to the same page, and the failure one says what stands
and what does not:

> Client record created. The intake packet was not sent: … Nothing has gone
> out — send it from the client's page once the template is fixed.

### The referral mix is counted over calls

The report reads `Inquiry`, not `Client`. Both carry `referralSource` — the
same fact, copied at conversion, deliberately unreconciled (§20) — and it
would have been easier to aggregate the client table, which already had the
column and did not need the enquiry stage to exist at all.

It would also have answered a different question. A mix built from clients
shows which sources send people; it cannot show which sources send people who
go elsewhere, because those people are not in it. "GPs are our biggest
referrer" and "GPs are our biggest referrer and half of them go elsewhere"
look identical from the client table and mean opposite things. The non-
conversion only exists on the enquiry, and that is the whole reason a
discarded row is retained rather than deleted at the moment it dies.

The rate divides by every call taken, open ones included. Dividing by the ones
that reached an ending would let a growing pile of unreturned callbacks read
as a stable conversion rate — the same category error as `confirmed / booked`
in §12, arrived at from the other direction.

Time-to-conversion is a median. One caller who rang in March and booked in
September is a true story about one person and a false one about the practice;
the mean tells it and the median does not. An empty sample returns `null`
rather than zero, because a practice that converted nobody this month has no
conversion time, and rendering "0.0 days" would be the most flattering
possible way to report the worst possible result.

### The comment that failed the build

The report first also answered "how long from the call to the first session".
It does not now, and what stopped it was the P0-1 lint from §19 — the one that
greps every source file for a query joining an inquiry to anything clinical.
It failed on a *comment*: the words explaining why the appointment join was
absent named the model, and the check reads source as text.

The check is right and the comment was wrong. A lint that guards against code
nobody has written yet cannot parse, and one that can be argued out of a match
is one somebody will argue out of a match. The number was also the wrong one
to want: it needs the clinical join the invariant exists to forbid, and the
retained enquiry row can honestly answer how long a call took to become a
client record without ever reaching for an hour that was booked.

### The number nobody here can choose

`inquiryRetentionDays` is on `/practice` with the sentence the PRD asks for:
how long a discarded enquiry should survive is a jurisdictional legal question,
not an engineering one. The default is a placeholder chosen so the sweep has
something to run against. Same shape as the auto-no-show banner from §11 — the
mechanism works, and a working mechanism is not a reason to ship a policy.


## 22. The warning that arrives after the record

*P1-2 of `prd-intake-inquiry.md`: matching a caller against the clients we
already have, without telling anybody anything about them.*

### It follows the record, it does not stand in front of it

The obvious build is a check on the way in: type a phone number, wait, get told
whether we know this person, then decide whether to save. That version has a
person on the phone while a query runs, and it puts a machine between front desk
and the thing they were asked to do, which is write the call down.

So the order is inverted. `recordInquiry` creates the enquiry and redirects to
`/inquiries?recorded=<id>`, and the page draws the warning if there is one:

```ts
const recorded = q.recorded ? inquiries.find((i) => i.id === q.recorded) : undefined;
const duplicates = recorded ? await possibleDuplicates(actor, recorded) : [];
```

The call is on file either way. If the match is real, the ending already exists
— `duplicate` has been in the discard vocabulary since P0-3 — so the warning
does not need a decision, it needs a next step that was already there.

An empty result draws nothing at all. "No match" is not the same statement as
"this is a new person", and a green tick saying the second one would be a
confident lie in exactly the case that matters: a caller whose old record is in
somebody else's caseload.

### A code, and nothing else, and nothing written down

What comes back is `{ id, code }`. Not a name, not a clinician, not a status,
not when they were last seen — enough to go and look, and nothing about
whoever is behind the code.

Nothing is stored either. The tempting version writes the matched client id
onto the enquiry, so the report can later count how many callers were already
ours. That is a client id on a row built to be destroyed, which is the single
thing P0-1 exists to prevent, and the PRD had already answered it for the
`duplicate` discard reason: the code is enough.

### The scope was already in the matrix

The interesting question is not front desk's — they read every client already.
It is a clinician's. A therapist takes their own call, types a number, and a
naive match tells them a client exists whose record they may not open. That is a
disclosure, in one line of grey text, of exactly what `read: treatingOrSupervising`
refuses.

So the match reuses the caseload list's scope rather than inventing one, which
is what the extraction of `caseloadWhere` is for:

```ts
async function caseloadWhere(actor: Actor) {
  if (!ownCaseloadOnly(actor)) return {};
  ...
  return { treatingClinicianId: { in: [actor.id, ...supervisees] } };
}
```

Front desk matches everyone, a clinician matches the clients they treat, a
supervisor's includes their supervisees'. No new cell, no new rule, and the
answer moves on its own the day a caseload is reassigned.

The practice manager is the case that decides the shape of the function. Their
client read is `breakGlass`, so a `guarded` call would refuse them — correctly —
and write a denial row for every call they record. That is a log full of
refusals nobody asked for, burying the ones that mean something, and a
break-glass prompt offered over a phone number is an invitation to open a
clinical record for a clerical reason. So the check is `may()` first and
`guarded` only when the answer is yes:

```ts
if (OR.length === 0 || !may({ actor, action: 'read', resource: 'client', target: OWN_CASELOAD(actor) })) {
  return [];
}
```

Two silences that are not the same silence: an enquiry with no contact details
is not an access event, and an actor who may not read clients did not attempt
one. Neither is a denial, and neither is logged. When the match does run it is
logged as what it is — a `read` on `client`, one row, one access.

### What this deliberately does not do

Matching is exact string equality. `555-0101` and `(555) 010-1` are different
people to this code, and a warning that sometimes misses is the failure this is
allowed to have — a warning that sometimes blocks is not. Normalising phone
numbers is a database function and a migration, and it can wait for somebody to
report a miss.

There is no live check as the number is typed, no fuzzy name match, and no
warning anywhere except immediately after the record. Front desk searching for a
client is already a page that exists.

## 23. The call that never got a status change

*P1-3 of `prd-intake-inquiry.md`: open enquiries older than N days, beside the
continuity queue.*

An unreturned call and a client with nothing booked are the same failure —
somebody the practice was supposed to follow up with, and didn't — but an
enquiry has no appointment table to go quiet in, so nothing before this could
say how long one had been sitting. `staleInquiries` is `continuityQueue`'s
shape read against `Inquiry` instead of `Client`: `status: 'open'` in place of
"nothing booked", `createdAt` in place of a last session, oldest first.

It reuses the cell `listInquiries` already reads under — `inquiry: { read:
'always' }` for front desk, admin, and every clinician (P1-2's write-up
covers why: a small practice discusses its own intake). No caseload scoping,
because the read that grants it has none either.

The window is a three-day default passed as an option, not a
`PracticeSettings` column. `continuityGapDays` earned a settings row because a
practice tunes what counts as a *clinical* lapse; how many days an unanswered
phone call sits before front desk sees it on a work list is an operational
default nobody has asked to move yet, and the column is one settings
migration away the day someone does.

## 24. The window, made visible before it fires

*P1-4 of `prd-intake-inquiry.md`, and the last item on it: a preview of what
the next purge sweep would destroy.*

`runInquiryPurge` decides its candidate set once — discarded, and past
`inquiryRetentionDays` — and then deletes it. Nothing before this let a person
ask that same question without triggering the answer. `previewInquiryPurge`
is that question: the identical cutoff, computed by a `purgeCutoff` helper
the two now share, with the delete swapped for a `findMany` that names the
rows instead of removing them.

It reads under the cell `listInquiries` already reads under — `inquiry: {
read: 'always' }` — for the same reason P1-3's did: a preview is a different
render of a row front desk and every clinician can already open, not a new
power over it. No permission cell was added, and none needed reviewing.

The enquiries page asks the question only when it already has discarded rows
on screen — the `status=discarded` filter — and marks the ones due with a
badge next to the discard reason. Everywhere else the page does the one query
it always did; a preview nobody is looking at is a query nobody needed to
run.

The seed's fifteen discarded calls used to span 8–78 days back, all inside the
90-day default — a page that always said "nothing is due" would have proven
nothing about the badge existing versus the badge working. Widening the
spread (called ×7 instead of ×5) puts the oldest past the window without
moving anything else a test depends on; nothing in the suite reads these rows
by their exact age, only by the fifteen-strong set and its referral mix.

## Decisions log

| Decision | Why |
|---|---|
| `process_note` and `progress_note` as separate resources, not one with a flag | A flag invites scattered `if (note.private)`; separate resources put the difference in the policy table where it is testable |
| `can()` returns a `Decision`, not a boolean | The audit log needs the rule that fired and whether break-glass was open; a boolean forces every call site to re-derive it |
| A `client` role in the matrix, empty on purpose | A tokenized submission gets an honest actor in the audit trail instead of being attributed to staff |
| Supervisor reach extends to a supervisee's caseload, except process notes | Countersigning blind is not supervision; the single exception is sharper against a full record than against an empty one |
| Denials logged outside the caller's transaction | A rolled-back request must still leave the attempt on the record |
| List reads logged once, not once per row | Forty audit rows for one page view buries the individual record opens that matter |
| The confirmation report reads under `attendance_history`, not `appointment` | A confirmation rate alone is operational, but a per-clinician silence breakdown carrying a fee total is not — the guard belongs on the strictest thing in the payload, never on the name of the feature |
| `WaitlistEntry` holds a client XOR an inquiry, enforced by a `CHECK` | Two nullable FKs invite a row nobody can ring and a row offered the same hour twice; the invariant is a database rule for the same reason the append-only trigger is |
| The one `ON DELETE CASCADE` in the schema points at the one deletable table | A waitlist entry for a person who no longer exists is not a thing — saying it in the FK is what keeps the purge ignorant of the table |
| Conversion pre-generates the client id | `guardedAll` authorizes before it acts, so both audit rows must name a client that does not exist yet; creating first and authorizing after inverts the order the guard exists to enforce |
| Conversion adds no matrix cell | It needs `create` on `client` and `update` on `inquiry`; only front desk holds both, so the answer was already in the table |
| `Client.referralSource` duplicates the intake form's answer, unreconciled | They are the same fact at two sensitivity tiers; syncing them would show front desk a clinical submission, and an equality test against the template's options is what stops them drifting |
| The confirmation rate divides by decided, not by booked | A `reminderPreference: 'none'` client would otherwise drag their clinician's number down for choosing a safety setting — the P0 category error, reappearing as a denominator |
| A declined hour and a cancelled one are shown as separate kinds of opening | The declined one is still on the books; rendering both as "free" is how a client arrives to find their room taken |
| The openings list never filters by how much notice an opening carries | The notice is shown and the list sorts by start; "too short to bother with" is a front-desk judgement, not a constant |
| Only a `no_response` no-show counts toward the policy's fee total | A late cancel is charged whether or not anyone was asked, so counting it would credit this feature with revenue it did not cause |
| `declineReason` is nullable and usually null | The portal asks without requiring an answer and a keyword decline cannot carry one; a default value would turn every texted "no" into a preference the client never stated |
| The decline reason reuses `RescheduleReason` rather than a new enum | A decline and a reschedule request ask the same four sentences; two lists would drift, and the PRD named reuse explicitly |
| Form question text is a language pair enforced at send time, not by the type | `CLIENT_TEMPLATES` is code, so the compiler makes a missing translation a build failure. A `FormTemplate` is data — the point is revising one without a deploy — so nothing stops an English-only question being published. `missingLanguages` runs where the form is *sent*, which is a practice manager holding a list of field keys rather than a client staring at blanks |
| `discard` as its own action, not `delete` | One resource, one verb; a generic `delete` in `ACTIONS` is a verb a later reviewer reaches for on a table that must never lose a row |
| Clinicians create inquiries but cannot discard them | Writing down a call you took is clerical; declaring one dead is the decision that destroys a row ninety days later |
| No break-glass cell anywhere in the admin `inquiry` row | A break-glass rule would imply there is something clinical here to reach — and the absence of clinical content is what makes the row deletable at all |
| Both inquiry endings terminal, including `discarded` | `discarded → converted` is not a wrong status, it is a row the purge is still aiming at while the practice believes it has a client |
| An untranslated question is left empty, never filled from the English | A fallback produces a template that passes every gate, sends without complaint, and shows English to somebody who cannot read it — the exact failure the deny-list pairing exists to prevent, one layer up |
| Localized labels live inside one template version, not in a second template per language | A per-language template forks a client's score history across two keys the moment they switch, duplicates the scoring rules by hand, and hands a Spanish submission to a clinician who does not read Spanish. One version works because a submission stores *values*: `3` renders as "Nearly every day" to staff and "Casi todos los días" to the client, off the same row |
| A data migration rewrites old template versions rather than reseeding | A submission renders against the version it was answered on, so publishing new versions would have blanked the labels on every historical submission — the failure versioning exists to prevent. The Spanish half is written empty, so old rows are honestly unsendable to a Spanish client instead of silently wrong |
| The form action returns a `Conflict` code, never the service's message | A service message is written for a log: it names template keys and versions and is English whatever the client reads. It was a small wrong shape with one language and a comprehension bug with two; unrecognised codes become `unknown` rather than leaking an internal name to a client |
| The dead-link pages render in every language at once | A dead token resolves nobody, so there is no `Client.language` to read — and defaulting to English puts the least helpful screen in front of the client least able to act on it. Two paragraphs, versus querying an expired token to learn what language to apologise in |
| Money is formatted `es-US`, not `es-ES` | `es-ES` renders the late-cancel fee with a euro sign: a currency error wearing a translation's clothes. A US practice bills a US client in dollars whichever language it explains them in, and the number is the one the client is agreeing to |
| The translation test forbids identical strings, with collisions listed by name | A copied value typechecks perfectly, which is the whole failure mode a type cannot see. Asserting no shared wording found exactly one genuine collision — `No` — and naming it is the same discipline `crisis` needed on the deny-list, rather than a looser assertion that would also permit the next real one |
| A tampered decline reason is dropped, not rejected | The reason annotates the decline, it does not authorize it — a bad form field must not stand between a client and giving the hour back |
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
| The e2e fixture for the door is built through Prisma, not as raw SQL | The pg adapter stores a `Date` as its UTC wall clock labelled in the session's zone. Write and read cancel out, so the application is self-consistent and every unit spec passes — but a fixture row inserted by hand with `now()` reads back skewed by the machine's UTC offset, and an appointment two hours away came back as already past and vanished from the client's door. The suspicion carried into the money phase was that the same skew reaches any column the *database* clock fills — `createdAt` defaults to `CURRENT_TIMESTAMP`, and `createdAt` is what `dueStages` calls the notice a booking had, so a fee would have rested on it. **Measured in phase 4, and it does not.** A row whose `createdAt` Postgres filled and a row whose `createdAt` the application wrote both read back through Prisma with zero skew on a UTC−5 laptop, and the notice `dueStages` sees for a booking six days out is 6.0000 days. The skew appears only through `$queryRaw`, where Prisma's own type handling is bypassed — and the only two raw statements in the codebase are a `pg_tables` lookup and an advisory lock, neither of which moves a timestamp. So the finding is real and narrower than it looked: it is a rule about hand-written SQL, not about `CURRENT_TIMESTAMP`, and the four-call-site refactor it seemed to demand was not needed. Worth keeping because the wrong version of it is expensive and, on a UTC box, untestable |
| The required response is a tap on a link, not a `YES` texted back | A message demanding a reply is more conspicuous on a lock screen than one that does not, and conspicuousness is not vocabulary — the deny-list governs words and cannot make a compulsory answer discreet. A keyword reply also opens an inbound channel front desk monitors, which a client can answer with a crisis disclosure. A link is one tap, works the same on SMS and email, needs no inbound channel at all, and puts the fee disclosure on a page where it can be read before it applies |
| The reminder carries the existing `PortalLink`, not a new per-appointment token | A second token type is a second expiry policy, a second revocation story, a second audit rule and a second thing to get wrong. The blast radius grows honestly instead: a forwarded link can now see appointment times, request a reschedule, **and** cancel — bounded by `classifyCancellation`, unable to reach another client's row, and every use on the record with the client as the actor |
| A decline cancels, though the reschedule request only asks | The portal's "it requests, it never books" rule is about creating commitments a person should see being made. A decline destroys one, and the practice's goal is a calendar that tells the truth — an hour the client has said they will not attend has to free the room, or the feature is theatre. The rail is that it routes through the same `cancelAppointment` front desk uses, so the 24-hour policy applies identically whoever clicked |
| The `client` role's one matrix cell, instead of a check inside the door | "What can a forwarded link do" should be answerable from the file that *is* the policy. Reading behind the link and asking for a different time change nothing and stay outside the matrix; confirming and declining change something, so they are a cell — `appointment: update` under a `token` rule that requires the row to belong to the token holder. The door still resolves ownership first, and still answers `NotFound` rather than `Forbidden`, so the second no never has to be given |
| The fee interstitial is a second tap, and the first tap changes nothing | Declining inside the late-cancel window is chargeable, so the first tap asks the server, the server decides from the clock, and the client is shown the amount in dollars before anything is cancelled. Outside the window there is nothing to disclose and the decline is one tap. Same code path, disclosure in front of one of them — the policy becomes something the client is told rather than something they discover |
| The portal token is re-rolled until it passes the deny-list | Once a link is substituted into a client-facing body, `assertDiscreet` scans the random token too, and 32 base64url characters hit a four-letter term like `ptsd` about once in 36,000 — roughly twice a year at this feature's volume, as a throw in the middle of a horizon run. One `while` in the generator removes the class for every template rather than for the one that surfaced it |
| The cadence is a script and a function, with no scheduler dependency | Due times derive from `startAt` and the injected clock, so the job is idempotent and the schedule is an implementation detail of whatever calls it — cron, a timer, a hosted trigger, or a person typing `npm run reminders:run`. A missed hour costs lateness and nothing else, and the whole five-day cadence runs in a test in a millisecond because the clock is an argument |
| The non-response sweep is its own module and its own script, not a second branch of the cadence | They are due at different times, fail in different ways, and only one of them can bill somebody. Splitting them means the money half can be stopped without stopping the reminders — which is exactly what a practice reviewing its client agreement will ask for, and it should be a command they do not run rather than a code change |
| The sweep records `no_response` whatever else it does, and gates only the money | The communication fact is the evidence. Four independent things can stop the charge — not at `scheduled`, client now unreachable, the flag off, never `pending` — and none of them stops the write. A practice that turns the money off gets the whole feature minus the money, plus a quarter of data about what non-response actually predicted before turning it on |
| The sweep asks `confirmationRequired` again at the moment of charging | The horizon only looks forward, so a client who switched to `none` after their last reminder is never pulled back to `not_required` by it. This is the last place that safety setting can still bite, and the fee is the thing it is protecting them from. It gates the money only: the silence is still recorded |
| The `no_show` transition goes through `setStatus`, so the sweep writes no status of its own | The existing lint says `status: 'no_show'` is written in one file, and the automatic path is precisely the one that would have been tempting to exempt. Routing through `setStatus` also means a sweep-set no-show and a human-set one derive the same fee from the same field — the policy is about the fact, not about who noticed it |
| `noShowFeeCents` defaults to the late-cancel figure, so the field changed nothing the day it shipped | The migration and the policy change are then reviewable independently, and a regression spec pins the existing fixtures on both sides of it. A practice charging 50% for a late cancel and 100% for a no-show is ordinary; one field could not express both, and the second field is the thing they can raise without a code change |
| The waiver is a new `waive` action on `fee`, not an `update` | Reversing money the practice already decided to charge is a different power from setting a sliding-scale rate, and the whole argument of `permissions.ts` is that a power nobody named is a power nobody reviewed. Front desk keeps `fee: read` and gets a 403 on the waiver, logged — which turns the existing "waiving a fee is a management decision" comment from an intention into a rule |
| The waived amount goes in the audit row's reason code, and the waiver leaves `status` and `confirmation` alone | The client still did not turn up; the practice chose not to charge, and the record should say both. Zeroing `chargeFeeCents` would otherwise be the only trace of what was reversed, and the audit table is append-only by a database rule — so the amount survives in the one place the waiver cannot rewrite |
| `no_response` writes get their own structural lint | It is the only confirmation value a fee can be derived from, and `confirmationRequired` is the only thing between it and a client who was never asked. The behavioural specs cover the sweep that exists; they say nothing about the batch job written next month that sets `no_response` from a query of its own and passes every one of them. Grep over `src/` and `app/`, verified by planting a violation — the same discipline as the author-only and `no_show` rules |
| The unconfirmed work list filters on "not confirmed", not on "pending" | Three different silences are the same phone call: nobody could be asked, nobody has answered yet, and somebody said no in a way that could not free the room. Narrowing to `pending` would hide the clients least likely to turn up — including every client on `reminderPreference: 'none'`, who can never confirm anything and are exactly who front desk has to ring |
| The client's phone number is on the work-list row, not one click away | The fee rests on the practice having given the client a chance to answer, and that is only true if somebody can actually make the call. A list that needs a second navigation to act on is a list that gets skimmed |
| The cadence cap narrows a set rather than adding a branch | `dueStages` gained an `allowed` argument, so every rule it already applied still runs. The cap can therefore only ever remove messages — a capped client booked inside the day-before lead still gets nothing, and no configuration of the cap can manufacture a stage that was never sendable |
| The cap does not touch the promotion to `pending` | Fewer messages is still a message. A capped client's silence rests on exactly the same outbox row as anybody else's, because the fee's evidence was never the number of times the practice asked. Had the cap suppressed the promotion, turning it on would have quietly exempted the practice's most reliable clients from a policy they are the least likely to trigger |
| Only *decided* and only *past* appointments move a confirmation streak | `not_required` and `pending` say nothing in either direction, which stops a client on `reminderPreference: 'none'` — who can never confirm anything — from reading as permanently unreliable. Past-only, because "until they miss one" is knowable only after the hour has gone; counting future confirmations would let a client mute their own reminders by answering early |
| A `declined` breaks a streak as surely as a `no_response` | A streak is a record of answering, not of agreeing. A client who is starting to decline is a client whose pattern is changing, and the five-day message exists for exactly that |
| The inbound classifier matches whole messages, never prefixes | `no I cannot come, my mother died last night` starts with a keyword and is not a keyword reply. A substring rule would classify it, act on it, and discard the rest with nobody told. The cost of strictness is a polite `yes thanks` reaching a clinician who did not need it; the cost of looseness is a disclosure nobody reads |
| A keyword decline records the answer and cancels nothing | The portal link carries 24 random bytes and shows the fee before it applies; a phone number is public and spoofable. Authentication is what is weaker over SMS, not authorization — so the inbound path writes an answer and never moves money, and the worst a forged `NO` achieves is a phone call the client was going to get anyway. It is also less code than the alternative: no window logic, no interstitial, no second cancellation path |
| Two clients sharing a phone number is treated as nobody's number | One line, two records is ordinary in this domain — a couple, a parent and a teenager, a carer. Confirming the wrong person's hour is the mild failure; an `unparsed` from a shared line would raise an alert about the wrong client to the wrong clinician, which is a disclosure. Two matches is handled identically to zero |
| The unparsed auto-reply names 988 in digits, not by name | It has to leave somebody a route to urgent help, and it arrives on a lock screen a roommate may be holding. The line is called the Suicide & Crisis Lifeline and both words are on the messaging deny-list — so the safest possible message would fail its own send if it named the service it points at. Naming the digits is what the sender actually needs; naming the service is what the deny-list exists to stop. The clearest evidence in the codebase that the deny-list is doing work rather than decorating a template |
| `InboundReply` gets a structural lint on its *columns*, not just behavioural tests | The specs prove the current code stores no body. They say nothing about the migration that adds a `body` column "just for debugging" next month — every one of them would still pass, because none of them would write to it. So the lint reads the model out of `schema.prisma` and asserts its only `String` fields are identifiers |
| The inbound channel is a command, not an HTTP route | The PRD asked for a "simulated inbound endpoint". An unauthenticated public POST that writes to a client's record needs a provider signature to verify, and a signature nobody issues is a security control that only looks like one. `npm run inbound:simulate` is honest about being a stub, the same way nothing sending is |
| Carrier opt-out keywords are left unparsed, reaching a person | `STOP` silently setting `reminderPreference: 'none'` would look like compliance without being it — real opt-out is enforced by the carrier and the provider above this layer. Routing it to a human is the honest behaviour for a simulation, and the wrong one to fake |
| The fee's precondition is a delivery receipt, not an outbox row | A queued message proves the practice *intended* to ask. The gap between intending and arriving is the practice's own infrastructure, and billing on the first makes a client pay for the second. `delivered` on at least one stage; `sent` never counts, because it is still the practice's own account of what it did |
| Delivery gates the money and not the write | The fourth independent thing that can stop the charge and the fourth that cannot stop the record. `no_response` is the evidence, and a client who was never reached was still silent — the practice just cannot bill for it |
| An undelivered sweep logs `no_response_undelivered` | A missing fee with no explanation is indistinguishable from a bug. It is the row a client disputing a charge needs, and the row an auditor looks for when the charge everybody expected is absent |
| A terminal receipt never moves, in either direction | A carrier reporting `failed` on a message it already reported `delivered` is retracting evidence a fee rests on. The first receipt stands and a human looks; a webhook may not quietly un-charge somebody, and may even less quietly start charging them. Duplicates are a no-op, because carriers retry |
| The reminder's link to its message became a relation with `onDelete: Restrict` | A dangling id is exactly the failure that would silently un-prove the ask. The evidence cannot be deleted out from under the fee, and the database enforces it rather than a convention — the same argument as the append-only audit rule |
| A per-client stage selection wins over the streak cap instead of intersecting with it | Intersecting `d0` with a capped `d1` is the empty set: a client who asked for *fewer* messages gets none, four confirmations after the box was ticked rather than on the day. The cap is a reduction the system applies for the client; the selection is the client having answered that question already. Applying both answers it twice |
| Empty means "the practice cadence", with no second flag beside it | Same argument as a streak cap of zero being the off switch. A `useCustomCadence` boolean next to a list is two fields that can disagree, and somebody will eventually update one of them |
| The selection is *which* stages, never *whether* | `reminderPreference: 'none'` is still checked first and the checkboxes do not render for a client on it. A cadence preference must not become a second, quieter way to turn messaging back on for somebody who asked for silence |
| The carrier stub always succeeds, and the failure is a seeded fixture | Random failures would make the hand-tallied fee totals unreproducible, and a fixture that only probably exists is a spec that only probably means anything. One client, three `failed` receipts, no charge — the one row in the quarter where `no_response`, `no_show` and no fee sit together |
| `Inquiry` is its own model, not a `Client` with nulls | The nullable-Client version inherits the waitlist, forms, outbox and portal for free, and requires a `DELETE` aimed at the foreign-key root of every clinical table. A separate model keeps deletion pointed at a table that by construction holds no clinical content |
| The deletion rule is a database trigger, not a check in the sweep | The sweep is careful today. `inquiry_delete_only_discarded` answers what happens when the next caller of `inquiry.delete()` is not — the same argument `audit_append_only` makes, and hard rule 5's principle generalised from immutability to deletion |
| A `CHECK` requires `discardedAt` and a reason on every discarded row | The sweep counts from `discardedAt`, so a discarded row without one is deletable in principle and immortal in practice — a failure that errors nowhere and simply leaves the row |
| Discard then purge, rather than an immediate hard delete | A mis-click at 9am has to survive until they ring back at 2pm, and a two-step makes the destruction clock-driven and therefore testable — which is what the injected clock already existed for |
| Audit rows about an inquiry carry `clientId: null` and the inquiry id in `resourceId` | That column means *a client record*. Keeping inquiry ids out of it is what lets a purged row leave its trail standing with nothing dangling and nothing to cascade |
| The audit trail is allowed to point at a row that no longer exists | The log records that a thing happened, not a joinable copy of the thing. Blocking the delete to keep the log joinable is how "deletable" quietly becomes "undeletable" |
| The discard and the purge write two different reason codes | `discarded:no_answer` and `purged` are two events about one id, and the one role that may read the log and not the record should be able to tell them apart |
| Conversion is gated by `create` on `client`, with no `convert` action added | The act creates a client, so the rule that governs creating clients already governs it. A seventh action would have been a new column on every role in the matrix and a fresh set of denial cells to review, for a decision that was already made and already tested |
| The Discard control is absent for a clinician, not disabled | A drawn-then-refused control teaches people that refusals are noise. `may()` decides what is drawn and the same matrix decides what the server does, so the menu cannot drift from the answer |
| Conversion does not send the intake packet; the page does, next | `issueForm` refuses a template the client cannot read in their language. Inside the transaction that refusal has two bad options — abort a conversion over a translation problem, or swallow it. Outside it, front desk gets a client record and a sentence saying the packet is still owed |
| The referral report counts enquiries, not clients | Both rows carry the source. Only the enquiry carries the calls that did not convert, and "GPs are our biggest referrer" and "GPs are our biggest referrer and half go elsewhere" look identical from the client table |
| The conversion rate divides by every call taken, open ones included | Dividing by the calls that reached an ending lets a growing pile of unreturned callbacks read as a stable rate — the same category error as `confirmed / booked`, from the other direction |
| Time-to-conversion is a median, and `null` on an empty sample | One caller who rang in March and booked in September is a true story about a person and a false one about a practice. And a practice that converted nobody has no conversion time; "0.0 days" would be the most flattering way to report the worst result |
| The report does not answer "call to first session", and a *comment* is what stopped it | The P0-1 lint greps source as text and matched the words explaining why the join was absent. The check is right: one that can be argued out of a match is one somebody will argue out of a match — and the number needed the clinical join the invariant exists to forbid |
| `inquiryRetentionDays` ships with the sentence saying nobody here can choose it | How long a discarded enquiry survives is a jurisdictional legal question. The default is a placeholder so the sweep has something to run against, and a working mechanism is not a reason to ship a policy |
| The duplicate warning follows the record instead of gating it | A caller waits while a check runs, and front desk is stopped doing the one thing they were asked to do. Recording first also means the warning does not need to be believed: the call is on file either way, and `duplicate` was already in the discard vocabulary |
| A match answers with a client code and nothing else, and nothing is written down | A name or a status would disclose the record the matrix was refusing. Storing the matched id would put a client id on a row built to be destroyed, which is the whole of P0-1 |
| The match is scoped by the caseload rule, and gated by `may()` rather than `guarded` | A clinician must not learn from a grey warning line that a client exists outside their caseload. And the practice manager, whose client read is break-glass, gets silence rather than a denial row per recorded call and a break-glass prompt over a phone number |
| The stale-inquiry window is a function default, not a `PracticeSettings` column | `continuityGapDays` exists because the gap defines a *clinical* lapse a practice tunes; how long an unreturned call sits before front desk sees it is an operational default nobody has asked to configure yet |
| The purge preview shares its cutoff with the purge, not its own copy | Two candidate-set computations that are supposed to always agree are one of them one edit away from silently not; `purgeCutoff` is read by both, so they cannot drift |
| The preview reads under `inquiry: { read: 'always' }`, with no new cell | Naming what the next sweep will destroy is not a new power over the row — it is the same read `listInquiries` already grants, pointed at a narrower `where` |
| `spam` and `referred_out` get their own retention column, the other five reasons do not | Both are `PracticeSettings` fields with their own default, same pattern as `inquiryRetentionDays` — not a per-reason table, because five of the seven reasons have never asked for a different clock than the general one and a column nobody reads is the thing this project's own ladder argues against |
| The purge's candidate query is one `OR` of per-reason cutoffs, not five separate queries | `purgeWhere` still runs once, for the same reason `purgeCutoff` used to be shared between the purge and its preview: two computations that must always agree are one of them one edit away from silently not |

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
