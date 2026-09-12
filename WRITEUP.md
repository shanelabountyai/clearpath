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

## 25. One cell wide, and the box that is not there

*P2 of `prd-intake-inquiry.md`: a public enquiry form, which the PRD itself
described as "a liability" until rate limiting and spam handling stood in front
of it.*

Everything else in this application is reached by somebody the practice knows:
a staff session, or a token that was emailed to one client. `/enquire` is
reached by a stranger, and it writes.

### The role, rather than the exception

The obvious build is a route that skips `guarded` — the actor is nobody, so
there is nobody to authorize. It is fewer moving parts and it changes no
policy file, and it fails the one test this project exists to pass. "What can
an unauthenticated request do to this database" has to be answerable by reading
`permissions.ts`. Written as a bypass it is answerable only by auditing every
route, for ever, and by everybody who ever adds one.

So `public` is a role, and it holds exactly one cell: `inquiry: { create }`.
No `read`, which is what stops the form from becoming a lookup — a submitter
must never be able to learn that the practice already holds this person, and
the way to guarantee that is for the anonymous actor to have no read anywhere
in the matrix rather than for each surface to remember not to offer one.

Its rule is named `unconditional`, and that is not a synonym for `always`.
`always` appears in six other rows and means "any actor holding this role" —
where every role holding it belongs to somebody the practice hired. Reusing it
here would make the anonymous cell look like the others, and would make an
accidental second use of it invisible. Two identical functions, two different
claims, and the audit row records which one decided.

### Where the limits actually live

The matrix says what an anonymous request may do. It cannot say how often, and
it should not try — a permission table that grew a rate limit would be a
permission table nobody could read. Four separate things bound this cell, and
all four are in `src/clients/public-inquiry.ts`:

- **A kill switch, off by default.** `publicInquiryEnabled` ships `false`. The
  route existing in a deployment is not the same as a practice consenting to run
  an unauthenticated write endpoint, and a practice being flooded needs to shut
  the door from the settings row rather than from a deploy pipeline.
- **An hourly ceiling per submitter**, keyed by an HMAC of the address and
  never by the address. A bare SHA-256 of an IPv4 is not anonymisation: the
  space is four billion values, so the table would be a recoverable list of
  everyone who enquired — concentrated, ironically, in the one table added to
  protect them. With no secret configured the key falls back to a per-process
  random, which fails *safe* rather than weak: the hashes stay unrecoverable and
  what degrades is the limit's reach across instances.
- **A honeypot**, answered with the identical screen a person gets. Telling a
  bot it was detected is telling whoever wrote it what to change.
- **A field set with nowhere to put a sentence.** Below.

The order of those checks is a decision, not an accident. Validation runs
*before* the throttle, because a real person who mistypes their email three
times must not find the form closed on the fourth attempt — and validation
costs no query, so nothing is bought by putting it second. The honeypot runs
*after* the throttle, because a robot should burn its allowance like everybody
else; checked first, a bot could hammer the endpoint for ever without the
counter ever moving.

### The box that is not there

This is the part I expected to argue myself out of and did not.

The PRD already names `Inquiry.note` as the honest weak point of the whole
design: front-desk free text will eventually hold something clinical, because
somebody rings and says why. Its stated mitigation is that the field is labelled
for scheduling preferences and the purge bounds the exposure. What is left
unsaid is the load-bearing part — a person hears "I've been having a hard time
since my brother died" and types *prefers mornings*. The mitigation is a human.

A textarea on a public counselling form is that same field with the human
removed. It would not occasionally receive a clinical disclosure; it would
receive them as a matter of course, written by people who have not yet spoken
to anybody, straight into a column that hard rule 3 says must not hold them.

The PRD had already rejected structured-only fields — as "unusable for a person
on a phone". That reasoning is sound and it does not reach here, because nobody
on this form is on a phone. So the public form asks for a name, one way to make
contact, an optional clinician and a referral code; it prints a line above the
fields asking the reader not to write about their health; and it leaves the rest
to somebody ringing back. What it costs is real: a submitter who can only do
evenings has nowhere to say so, and front desk asks when they call.

The absence is asserted rather than intended. A source-level test greps the
service, the page and the action for a `textarea` or a `note` field, because the
failure mode is not this commit — it is somebody adding "anything else we should
know?" in six months, reasonably, without any of this context.

### The null that is a fact

`Inquiry.takenById` was a required foreign key to a `User`, and a public
submission has no such person. Making it nullable is the whole change, and the
null is not a gap in the data — it *is* the datum: nobody took this call, it
arrived. On the worklist that is the badge "From the website", which is exactly
the operational meaning wanted: an enquiry that has reached the practice with
nobody yet having spoken to the person behind it.

Two things fell out of that. Prisma's default for an optional relation is
`ON DELETE SET NULL`, which would quietly rewrite a staff-taken call into a
web-arrived one the day a staff account was deleted; it is pinned back to
`Restrict`. And deciding "is there a staff member behind this act" is role logic,
so it is `actingStaffId` in `permissions.ts` rather than an
`actor.role === 'public'` in the repository — which the grep test would have
caught, and which is the point of having the grep test.

### The fixture that turned out to be an assertion

The e2e spec's cleanup deleted the rows it had created, and every test after the
first one failed. The delete trigger refuses to destroy an `open` inquiry, and
it is a database rule, so raw `psql` is bound by it exactly as the application
is. The fixture now discards before it deletes — the same two-step the purge
takes — which makes the teardown a demonstration of the invariant rather than a
workaround for it.

## 26. Two hands on one decision

Front desk takes a call and has to decide where it goes. That decision has two
inputs and they belong to two different people: *where should this go* is
operations, and *can I take somebody new* is a judgement about a caseload only
the person carrying it can make. Almost every version of this feature collapses
them — one screen, one role, one column — and the collapse is invisible until
the day somebody is marked as having room by somebody who does not have to see
the client.

So the feature is two cells in the matrix, deliberately held apart.

**Assignment reuses a cell that already existed.** `Inquiry.assignedClinicianId`
is written by `assignInquiry`, guarded by `update` on `inquiry`. Front desk and
the practice manager hold that cell; clinicians do not, and that was already
true before this feature — P0-4 gave clinicians `read` and `create` on the
grounds that recording a call is clerical and ending one is operations. Deciding
where a call goes is the same category, so the answer was already in the table
and no new cell had to be reviewed. A clinician cannot assign a call to
themselves, which reads as a restriction and is really the same rule: taking
work is still a decision about where the practice's intake goes.

It is separate from `requestedClinicianId` on purpose. One is what the caller
said and the other is what the practice decided, and a practice that collapses
them loses the case it most needs to see: the call that went somewhere other
than the name the person asked for.

**Capacity is a new resource, and the interesting cell is a denial.**

The obvious home for "am I taking new clients" is a boolean on `User`, edited
through `user: { update: … }`. The practice manager already holds that cell. The
problem is what else is in it: `user.update` is roles and supervision, and
giving a clinician the reach to set their own capacity through it gives them the
reach to set their own role. That is the argument P0-4 already makes about
`discard` and `delete` — a power nobody named is a power nobody reviewed — so
capacity became its own resource holding exactly one boolean about oneself, with
a new rule to match:

```ts
self: (a, t) => t.subjectUserId !== undefined && a.id === t.subjectUserId,
```

Narrower than `recipient`, which is about delivery. This one says the row has no
meaning apart from whose it is.

| role | capacity |
|---|---|
| therapist / associate / supervisor | `read: always`, `update: self` |
| front_desk | `read: always` |
| admin | `read: always` |
| auditor / client / public | — |

Admin reads every row and writes none. It is the only cell on this page the
practice manager is denied, and there is nothing clinical in it to justify the
denial — which is exactly why it is worth stating. A manager who can mark a
clinician open has changed what the signal means, from *what this clinician can
carry* to *what the practice would like*, and the row they overwrote was the
only record that somebody disagreed. Deactivating a departing clinician is still
`user.update`, which admin does hold; declaring that somebody has room is not
the same act. A supervisor cannot set it for a supervisee either, and that one
took a test of its own, because supervision reaches everything else in this
codebase except process notes.

The service function takes no subject:

```ts
export async function setCapacity(actor: Actor, accepting: boolean)
```

A parameter would be a second way to name a subject, and the only thing it could
ever express is the case the matrix exists to refuse. The form has no hidden
field for it either.

**Half the signal is never typed.**

`acceptingNewClients` is declared and maintained by a person. Caseload and queue
depth are not: they are counted off rows that already exist — active clients
with that treating clinician, open enquiries already in that queue — through a
filtered relation count, with no column anywhere.

That asymmetry is the whole of the design. A declared boolean is cheap to keep
true because it changes when the clinician decides it changes. A declared
*number* is wrong by Thursday, and a stale capacity figure is worse than none,
because front desk would believe it. So the number is measured and the judgement
is declared, and each is held by the thing that can actually keep it honest.

**A signal, never a gate.**

Assigning a call to a clinician who has closed their books succeeds. The warning
is drawn on the row rather than in place of the control, and it stays there
afterwards, because somebody can close their books an hour after a call landed
with them.

Blocking would have been one line and would have been wrong. A caller who rang
and asked for Alex by name belongs with Alex whatever Alex's books say, and a
hard block teaches exactly one behaviour: flip the boolean to get past it, which
destroys the signal for everybody else. `no_capacity` was already in the discard
vocabulary from P0-3, and it is the honest ending when the answer is really no.

The last piece is what the page uses to decide whether to draw the toggle. Not a
role check — hard rule 1 forbids one and the grep test enforces it:

```ts
const mayDeclareCapacity = may({
  actor, action: 'update', resource: 'capacity', target: { subjectUserId: actor.id },
});
```

"Is this person a clinician" is not a question the page asks. "May this person
declare their own capacity" is, and the answer draws both the toggle and the
*Yours* filter that shows their own queue. The two questions have the same
answer today. Only one of them stays correct when the matrix changes.

## 27. When a code stops being enough

`referralSource` was an enum with four values, and for most of them an enum is
the right answer forever. "A friend told them" is a complete fact. "They found
us online" is a complete fact. `gp` is not: it names a category with six members
in it, and the practice deals with those six members individually.

The tell is what the report could and could not say. `GP — 40% of calls, 55%
convert` is a true sentence nobody can act on. The sentence somebody acts on is
`Riverside sent eleven and nine became clients; Marsh Lane sent nine and one
did` — that is a phone call to make this week, and no amount of care taken over
the enum was ever going to produce it. A code answers *how many*. Only an entity
answers *which*.

### One table, two directions

`referred_out` had the same shape and the opposite arrow: the practice sends
somebody to a specialist service and records only that it happened. The obvious
design is two models, `Referrer` and `ReferralDestination`, because inbound and
outbound sound like different things.

They are not different things. They are the same six surgeries seen from two
sides — the service you refer an eating-disorder case *to* is the practice that
sends you their anxiety referrals next month — and two tables would have held
that relationship twice and let the halves drift into two spellings of the same
surgery. So `Referrer` is one table and `Inquiry` carries two nullable foreign
keys into it, `referrerId` and `referredOutToId`. A row can legitimately have
both: a GP referred them in, and the practice referred them somewhere else.

### The empty cell is the interesting one

The new resource is `referrer`, and its rows read almost exactly like `inquiry`:
clinicians get `read create`, front desk and the practice manager get `update`
as well. That parallel is deliberate — writing down which surgery sent a caller
is clerical, the same as writing the call down; curating the list every future
call reads is operations.

The cell worth reviewing is the one that is not there.

```ts
public: { inquiry: { create: 'unconditional' } },
```

Unchanged. The public enquiry form (§25) may create an enquiry and holds nothing
on `referrer`. That is not an oversight and it is not symmetry for its own sake:
an enquiry is one row about one caller with a retention window counting down on
it, and a referrer is a permanent shared string that every future call sees in a
picker and every future report groups by. Letting an anonymous submitter write
one is a much longer-lived write than the one they came to make.

So a public submission that says "my GP sent me" stays a bare code. What that
costs is a phone call to find out which surgery — which is a call the form was
always going to need anyway, because there is no free-text box on it either.

### The rule that is not a validator

Two invariants: a surgery only belongs with `referralSource = 'gp'`, and a
destination only with `discardReason = 'referred_out'`. The instinct is a
validator in the service, throwing on the bad combination.

The database holds them instead:

```sql
ALTER TABLE "Inquiry" ADD CONSTRAINT "inquiry_referrer_only_for_gp"
  CHECK ("referrerId" IS NULL OR "referralSource" = 'gp');
```

The same argument hard rule 5 makes about append-only audit rows: a rule that
lives only in the module everybody is *supposed* to call is a rule that holds
until somebody does not call it. The seed writes inquiries with the raw client,
and the constraint means a fixture that got this wrong fails the seed instead of
quietly writing a row the report mis-counts.

But the service does not throw. It *shapes*:

```ts
const gpOnly = (data: Partial<InquiryInput>) =>
  data.referralSource === 'gp' ? {} : { referrerId: null };
```

Because the form has no JavaScript, the surgery picker cannot hide itself when
somebody changes the source select above it. A `Conflict` there would be a 500
on an ordinary change of mind. So the service drops the field and the database
forbids the row — two mechanisms doing two different jobs, and only one of them
can be routed around. The unit tests assert both halves separately, including
one that writes through `prisma.inquiry.create` specifically to prove the
constraint fires for a caller the service never sees.

`updateInquiry` needed one more line than expected. Clearing the referrer
whenever the source is not `gp` would clear it on *every* partial edit that did
not mention the source — adding a scheduling note would silently drop the
surgery. So the shaping runs only when `referralSource` is actually being
written.

### Retired, never deleted

`Referrer.active` is a boolean and there is no `discard` action anywhere in the
`referrer` row of the matrix. A surgery that closed its list in June is a fact
about June onwards; it is not a reason to rewrite what a report said about
March, and the enquiries pointing at it still have to be able to name it.
`onDelete: Restrict` on both relations says the same thing to anybody reaching
past the service, and a test proves the database refuses to delete a contact an
enquiry still points at.

The other direction matters too: the retention purge destroys the enquiry and
leaves the referrer standing. The directory is a business contact list, not a
record of a caller — it holds nothing the retention window has any claim on.

### What this deliberately does not do

**`Client` gets no `referrerId`.** Conversion copies `referralSource` and
`referralNote` onto the client (P0-9) and does not copy the surgery. The
converted enquiry is retained forever — that is what makes "how long from call
to first session" answerable — so the fact is still reachable, and nothing
currently reads a client-side copy. A second column would be a second thing to
keep in step for a question nobody has asked yet.

**No "Unknown" bucket.** A `gp` call with no surgery recorded is simply absent
from the referrer table rather than aggregated under a name. The honest reading
of that null is "nobody wrote it down", and in the seeded data an Unknown bar
would sit at the top of the table and read as a statement about the practice's
largest referrer.

**No deduplication.** `@@unique([practice, name])` stops the exact same pair
being typed twice, and nothing stops "Riverside Surgery" and "Riverside
Surgery " from both existing. Fuzzy matching a directory of six entries curated
by the two people who ring them is a solution looking for a practice ten times
this size.

## 28. The picture that has to be able to fail

The design brief asks for a five-frame storyboard: an associate signs a progress
note, it reaches their supervisor's queue, the supervisor co-signs it, the
supervisor is refused the same client's process note, and the auditor's log
shows both events. It calls this "the project's whole argument in one take."

The README had four pictures and none of them were those frames. The co-signature
arc — the part where authority flows *upward* to a supervisor and stops dead at a
private note — had no picture at all. What existed instead were four true
statements captured separately: a calendar, a locked panel, a break-glass gate, a
filtered audit view. Each one is evidence. None of them is a story, because
nothing in the set establishes that they are the same note, the same client, or
the same afternoon.

### Capture is a test that renders

The pictures are taken by `e2e/screenshots.spec.ts`, running against the same
seeded practice the suite runs against, under `npm run shots`. That is not a
convenience. A screenshot pasted into a README is a claim with no mechanism for
becoming false: the product moves, the picture does not, and a year later the
document is confidently describing software that no longer exists.

Captured by a spec, the picture cannot drift without the capture breaking first —
and this run proved it twice, in the two ways that matter.

**The first failure was the capture disagreeing with the app.** The spec found
the queue row by client name and took `.first()`. There are now two notes for
that client in the queue, and `.first()` is whichever the ageing order puts on
top — so it co-signed the wrong one and then waited five seconds for a
`Co-signed` badge that was never going to appear. A prose README would have
shown a queue screenshot and a co-signed screenshot and quietly implied they
were the same note. The fix is to locate the row by the note's own link, and it
went into `e2e/confidentiality.spec.ts` too, where the same `.first()` had the
same latent hole: the assertion "the queue no longer contains this client" had
been passing on a queue that happened to hold one such note, and would have gone
on passing without the signature under test ever arriving.

**The second failure was the picture disagreeing with the argument.** The audit
frame is supposed to show a grant and a refusal in one table. Taken in the
obvious order it showed the co-signature, and the refusal was below the fold —
because the refusal in the log was the *seed's*, minutes older than everything
the demo had just done. Ordering the direct process-note fetch last, after the
locked panel, puts the demo's own refusal at the top of the log where the
co-signature can be seen next to it. The frame now reads bottom-up as the story
actually happened: Priya writes, updates, signs; Rosa co-signs; Rosa opens the
record; Rosa asks for a process note and is refused.

### The row that reads like the bug

One row in that picture says `Rosa Iyer · Supervisor · read · process_note ·
allowed`, two rows from a headline claiming supervisors never read process notes.

It is not a leak, and checking rather than assuming is the whole point of having
the picture. `listProcessNotes` filters `authorId = actor.id` in SQL and selects
no `content` column at all; the client record renders that card for anyone who
authors process notes, so what Rosa read was *her own* notes for this client, of
which she has none. The card says "Nothing here yet." The locked panel about
Priya's notes is a different component entirely.

What the row exposes is a property of the audit log that is deliberate and easy
to misread: **it records the request and the outcome, never the rows returned.**
It cannot say "read her own" versus "read Priya's", because saying so would mean
putting the subject of a process note into the audit trail, and the rule is ids
only. So the log is honest and ambiguous at the same moment, and the ambiguity is
the cost of the rule rather than a defect in it.

The lazy response would have been to crop the row out of the picture. It stays,
with a paragraph in the README explaining it, because a reader who notices it and
finds no explanation has been handed a reason to distrust every other frame.

### What the seed had to give up

Frame one requires a note that is not yet signed. The seed's "the demo,
guaranteed" block already existed because the pairing of a queued note and a
process note was likely but not certain under the seeded PRNG; the same argument
applies with more force to a draft, since 85% of notes get signed and the demo
client would lose its draft to a seed tweak nobody connected to the README. The
block now constructs three things instead of two, and the ordering carries the
fiction: the most recent session's note is the unsigned one, because you write up
the session you just had.

### What this deliberately does not do

**No visual regression assertion.** The capture proves the walk still works, not
that the pixels are unchanged. A pixel diff on a seeded practice with a
database-clock timestamp is a test that fails for reasons nobody wants to read;
the one timestamp column is masked in the capture precisely so a *human* diff of
the committed PNG means the product moved.

**No dark-mode pair.** Every frame is captured in one theme. Doubling ten
pictures to prove the tokens work in both is a claim better made by the tokens
themselves than by twenty files in `docs/`.

## 29. The record follows the client; the notes never do

A clinician gives four weeks' notice. On the last day the practice needs the
fifteen clients on their caseload to have a new therapist, and it needs that
therapist to be able to read what the last one wrote.

What Clearpath could do about that before this phase, stated accurately:
`User.active = false`. That flag blocks a login and drops the person from a
picker. Fifteen `Client` rows still named them as the treating clinician, every
draft note they left was permanently unsignable, and the most sensitive content
in the database — their process notes — had exactly one permitted reader, who
could no longer log in.

None of that was a bug. Each of those is a rule this project argued for and got
right. A departure is simply the first event that asks all of them the same
question at once.

### The outlier nobody had noticed

Look at the clinical matrix as it stood. `client`, `fee`,
`attendance_history` and `form_submission` are all `treatingOrSupervising` —
the clinician who treats this person, and the supervisor responsible for them.
`form_submission` is screener answers and risk scores, which is clinical data
by any reading.

`progress_note.read` was `authorOrSupervisor`.

So the official record — the one document that exists to say what care was
given — was the *only* clinical resource on a client's record narrower than the
record around it. A clinician taking over a caseload could read their new
client's PHQ-9 scores and could not read a word of the notes explaining them.

That was coherent for exactly as long as a client's clinician never changed,
which is a thing this codebase had never made happen. The widening is one cell:

```ts
progress_note: {
  read: 'authorSupervisorOrTreating',   // was: 'authorOrSupervisor'
  create: 'treating',
  update: 'author',
  sign: 'author',
}
```

Three claimants, unioned: whoever wrote it, the supervisor responsible for that
author, and the clinician who carries the client *now*.

**The name is deliberately clumsy.** `recordReader` was the elegant candidate,
and it was rejected: it names a role, and every other rule in the file names a
relationship — `author`, `treating`, `recipient`, `self`. At the call site the
only useful question is *who exactly*, which an enumeration answers and an
abstraction hides. The name also travels: `Decision.rule` goes into the audit
row, so the auditor reading why a note was opened gets the enumeration too.

And it is honest about what this cost. The widening is not scoped to
transferred clients — there is no such thing yet. Any clinician may now read
the progress notes of any client they treat, whoever wrote them. That is
strictly more clinical access than yesterday, granted to every clinician at
once, which is exactly why it is a numbered decision and a matrix cell rather
than a grant handed out inside a transfer. Doing it inside the transfer would
have been narrower and worse: the answer to *who can read this note* would have
moved out of the one file that is supposed to answer it.

### The same sentence, twice, in opposite directions

`process_note` is untouched. `read: 'author'`. Admin has no entry; break-glass
does not reach it; the receiving clinician is refused.

This is the pair the whole project has been building toward, and departure is
what finally makes it *visible*. One client, one clinician, one moment:

```ts
const inherited = { authorId: alex, authorSupervisorId: sam, clinicianId: beth };
can(beth, 'read', 'progress_note', inherited).allowed;  // true
can(beth, 'read', 'process_note',  inherited).allowed;  // false
```

The record transfers because it is *the practice's record of care*. The private
notes do not because they were never part of it. Same sentence, both answers —
and it is a sharper demonstration than any denial test in isolation, because
here the opposite rule is applied to the neighbouring table for the same reader
at the same instant.

### `depart` is its own action

`Action` gained `'depart'`; `Resource` gained `'departure'`. Admin already held
`user.update`, which is where roles and supervision live, and deactivating an
account is a `user.update`. The temptation was to stop there.

Executing a departure deactivates an account, moves fifteen clinical records to
new readers, abandons one body of notes and schedules the destruction of
another. Same row underneath, three orders of magnitude of blast radius — and
this file's standing argument, third time of asking after `waive` and
`discard`, is that **a power nobody named is a power nobody reviewed.**

The column that resulted is more interesting than the action:

| role | departure |
|---|---|
| admin | `read` `create` `update` `depart` |
| supervisor | `read` `update` |
| front_desk | `read` |
| therapist / associate | `read: self` |
| auditor / client / public | — |

A supervisor shapes the plan and cannot execute it: proposing who takes which
client is exactly the judgement supervision exists for, and pulling the trigger
deactivates an account, which is the practice manager's act. Front desk reads
it because they answer the phone to "who will I be seeing?", and holds nothing
else because who receives a caseload is a clinical-fit judgement. A clinician
reads `self` — your own leaving is a thing you are entitled to see recorded
correctly, and a colleague's dispositions are not yours.

**There is no break-glass cell anywhere in the column,** and a test asserts the
absence by running every role and action twice, with and without a reason
typed, and requiring the two answers to match. A departure plan holds a client
list at the demographic tier and no clinical content. There is nothing here to
break glass for, and a cell that exists "just in case" is one somebody
eventually uses.

`create` also carries something the intake work wrote down as a cost and could
not pay: recording a departure closes the departing clinician's books. Intake's
D-09 refused admin `capacity.update` on the grounds that a manager who can mark
a clinician *open* has replaced the clinician's judgement with the practice's
preference — and it noted, in writing, that a clinician leaving with their books
open is a wrong signal nobody else can correct. `departure.create` closes them
and can never open them. The asymmetry is the decision: closing never overstates
what somebody can carry, and it is derived from a dated employment fact rather
than typed as an opinion.

### What the test file grew

Adding a resource and an action to this codebase is not a two-line change,
because `permissions.test.ts` enumerates every role × resource × action cell and
probes it three ways. One new resource and one new action took the matrix from
896 cells to 1,088, and the suite from 2,455 tests to 2,861. Every one of those
new cells had to be declared allowed-for-somebody or denied-for-everybody in a
spec written from the PRD rather than read back off the matrix.

That is the test doing the job it was built for. The correct response to it
going red is to fill the cells, never to narrow the test.

### What has not happened yet

Stated plainly, because a rule that no call site can satisfy is a comment:
**the widening is not yet reachable at runtime.** `notes/service.ts` builds its
authorization target from the note (`authorId`, `authorSupervisorId`) and never
resolves the client's current treating clinician, and `listProgressNotes` scopes
its SQL to the author and their supervisees. Both are correct for the rule that
was there yesterday and both are now narrower than the policy. The policy is the
thing that had to be decided in one reviewable place first; the two queries that
serve it are a Phase 3 edit with the transfer they exist for.

## 30. Making the wrong row impossible to write

Phase 1 of the departure was pure logic: a permission column, a widened read
rule, a three-state machine. None of it could be stored. This phase is the
schema underneath it, and the interesting part is how little of it is columns.

### A plan, and a row per client

`Departure` is `userId`, `noticeAt`, `lastDayOn`, `status`, `plannedById`,
`executedAt?`. Two dates rather than one, because the gap between them is the
entire design: notice closes the clinician's books, execution closes the
account, and the thirty days in between are what the practice needs to decide
fifteen dispositions and clear the hour clashes.

`DepartureAssignment` is one row per client — `disposition`, plus a receiving
clinician or a referral destination, plus who decided and when. The rejected
alternative was a single `receivingClinicianId` on `Departure`, which would have
made the common case one field and the real case impossible: real caseloads
split, some clients following the clinical fit, some following the hour, some
ending.

### The rules Prisma has no syntax for

Five of this phase's decisions are constraints, not columns, and each one exists
because the application-level version of it is a validator somebody can route
around with a hand-rolled write.

**One open departure per person, and not one ever.** A plain `@unique` on
`userId` says a person may only ever leave once, which forbids the P2
returning-clinician case — rehired eighteen months later, leaving again in
2031. What is actually true is that a person may not have *two plans in flight*,
so the index is partial:

```sql
CREATE UNIQUE INDEX "departure_one_open_per_user" ON "Departure"("userId")
  WHERE "status" = 'planned';
```

Terminal rows fall outside it. The test asserts both halves — a second plan is
refused, and the same second plan succeeds the moment the first is cancelled —
because an index that only ever gets tested in the refusing direction is an
index nobody has checked the shape of.

**A transfer with nobody receiving it.** Goal 2 of the PRD is that every client
has an explicit disposition with no default and no silent remainder. A
`transfer` row with a null `receivingClinicianId` is precisely the silent
remainder wearing a decision's clothes, and a receiver named on a `discharge` is
a colleague who is taking nobody. The constraint is biconditional because both
directions are wrong:

```sql
CHECK (("receivingClinicianId" IS NOT NULL) = ("disposition" = 'transfer'))
```

The referral destination is *not* biconditional, and the asymmetry is
deliberate: a destination on a discharge describes a referral that did not
happen, while a `referred_out` with no destination is an honest row about a
practice down the road that is not in the contact list. It follows
`inquiry_referred_out_has_a_reason` exactly.

**An execution with no date.** `("status" = 'executed') = ("executedAt" IS NOT
NULL)`, in the register `inquiry_discard_is_complete` set. A departure marked
executed with no timestamp is an event with no date, and an `executedAt` on a
planned row says the caseload moved before anybody pressed the button. Both
would be read straight past by every report.

### The note nobody may sign

`ProgressNoteStatus` gains `abandoned`, and adding it turned out to need two
migrations rather than one. Postgres permits `ALTER TYPE … ADD VALUE` inside a
transaction but forbids *using* the new value in the same one — and the CHECK
constraint below is exactly that use. Prisma runs each migration in a
transaction, so the enum value ships alone in
`20260910161613_progress_note_abandoned` and everything that mentions it
follows in the next. That is the documented shape of this, not a stylistic
choice, and it is worth writing down because the failure is a migration that
passes review and fails on deploy.

The status carries its cause:

```sql
CHECK (("status" = 'abandoned') = ("abandonedByDepartureId" IS NOT NULL))
```

A note in that status naming no departure is a draft somebody closed by hand.
A departure named on a note in any other status is a claim the record cannot
support.

The transition rule went into `progress_note_content_frozen`, the trigger that
already owned this column, rather than a second trigger racing it:

```sql
IF NEW.status = 'abandoned' AND OLD.status <> 'draft' THEN
  RAISE EXCEPTION 'only a draft can be abandoned (was %)', OLD.status;
END IF;
IF OLD.status = 'abandoned' AND NEW.status <> 'abandoned' THEN
  RAISE EXCEPTION 'an abandoned note is terminal; its author is gone';
END IF;
```

The first clause is the one that matters. Without it, `abandoned` is a way to
retire an inconvenient signature — take a signed note, mark it abandoned, and
the record now says a session ended without an attestation that was in fact
made. Everything else about this feature is designed to keep a hole visible;
that clause is what stops the same status being used to make one.

**Three places the new value would have lied.** Adding a value to an enum is a
one-line diff whose blast radius is every exhaustive branch that was not
exhaustive. `coSignProgressNote` refused `draft` and refused `cosigned` and let
everything else through, so an abandoned note was co-signable — a second name on
a record nobody ever signed, which is the exact false attestation `sign:
'author'` exists to prevent. `amendProgressNote` refused only `draft`, so a
supervisor could append content to a note that was never a record. And both note
badges ended in `return <Badge tone="success">Co-signed</Badge>`, so an
abandoned note would have rendered on the client record as co-signed. None of
those were caught by a type error; a string enum widened underneath them and
every `if` chain kept compiling.

### The window that ends the private notes

`ProcessNote.unreachableSince` records when the only permitted reader stopped
existing. It grants nobody anything — `read: 'author'` was already true and
already unsatisfiable — and it is what the destruction window counts from.

The window is `PracticeSettings.processNoteAfterDepartureDays`, shipping at
seven years. The PRD is explicit that it is not defending the number, and the
reason for erring long is asymmetric: in several jurisdictions those notes are
the clinician's own defence in a complaint made two years later, so destroying
too early is a much worse failure than holding too long.

The invariant is not the window:

```sql
CREATE OR REPLACE FUNCTION "process_note_delete_only_after_departure"() …
  IF OLD."unreachableSince" IS NULL THEN
    RAISE EXCEPTION 'a process note can only be destroyed after its author departed';
```

Second deletion rule in this codebase, written the same way as the first
(`inquiry_delete_only_discarded`), because hard rule 5's principle generalises:
the retention *window* is application policy, and the invariant that a reachable
private note may not be destroyed at all is not.

**The hole `ON DELETE SET NULL` would have left.** `NoteAmendment.processNoteId`
was `SetNull`, which sounds harmless and is not: an amendment carries its own
`content`, so a nulled parent link is the text of a private note surviving the
note it belonged to. The sweep would have destroyed the row and kept the words.
It is now `Cascade`.

That immediately collided with the append-only trigger on `NoteAmendment` —
which, it turns out, meant deleting a process note with amendments had *always*
failed, `SetNull` included, because a FK's own UPDATE fires the same trigger.
So the rule is now stated with exactly one hole in it:

```sql
IF TG_OP = 'DELETE' AND OLD."processNoteId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "ProcessNote" p
                   WHERE p.id = OLD."processNoteId" AND p."unreachableSince" IS NULL)
THEN RETURN OLD; END IF;
RAISE EXCEPTION 'NoteAmendment is append-only (attempted %)', TG_OP;
```

The inversion is the whole lesson, and the first version got it backwards. I
wrote `EXISTS (… unreachableSince IS NOT NULL)` — permit this delete if the
parent is a process note that is already unreachable — on the assumption that a
cascade deletes children before the parent. It does not. Referential cascade is
an **AFTER**-delete action on the parent row, so by the time the child's trigger
runs the process note is already gone and no `EXISTS` on it can ever be true.
The test failed with `NoteAmendment is append-only (attempted DELETE)` from
inside the sweep, which is the correct failure and a legible one.

Phrased as the absence of a *reachable* parent, the condition is true in both
orders: the parent still present and unreachable, or the parent already deleted
— which it can only be behind `process_note_delete_only_after_departure`, so
the hole does not widen. An amendment to a reachable process note stays
undeletable, a progress-note amendment stays undeletable, and every UPDATE is
refused exactly as before. There is a test for each.

### The sweep, and the door it deliberately does not use

`runProcessNotePurge(clock)` is driven from executed departures, not from the
notes. That is not an optimisation — it is the only query shape that can name
`authorId` in the SQL, which is hard rule 2, asserted structurally by a grep in
`notes/service.test.ts` that fails the build on any `processNote` query without
it. Driving it from `unreachableSince` alone would have needed a `findMany` with
no author in it, and the build would have said so. The constraint produced the
better design: the sweep cannot reach a note whose author is still here whatever
that column says, and the database refuses it a second time.

It logs with `auditEvent`, not `guarded`, and that is the point rather than a
shortcut. There is no cell in the matrix that lets anybody but the author touch
a process note — `SYSTEM_ACTOR` included, admin included, break-glass included —
and inventing one so that a sweep could pass through the front door would be the
widening this entire feature exists to refuse. A retention window expiring is
not an actor exercising a power. The audit row still lands in the same
transaction as the deletion, per hard rule 4, carrying ids and a reason code,
and the sweep never selects `content` on the way past.

### The trail of somebody who no longer works here

The last thing a departure does is `User.active = false`, and `active` is the
flag every person picker in the app filters on. If that filter ever reached the
audit path, the trail of exactly the person most likely to be under review would
silently blank — an empty screen, never an error.

Two assertions, because the risk lives in two places: `queryAuditLog` still
returns a deactivated actor's rows, and — structurally — the audit page's
`user.findMany` has nothing in it. The second is a grep, because the failure
mode is a filter somebody adds later for tidiness, and no behavioural test of a
page that renders correctly today would ever notice.

## 31. The transaction, and the door it could not use

Phase 2 made the wrong row impossible to write. This phase writes the right
ones — a caseload, a supervision tree, the drafts, the private notes and an
account, in one transaction — and the interesting parts are the three places
the PRD's own sketch turned out to be wrong.

### First, the rule nobody could satisfy

Phase 1 widened `progress_note.read` to `authorSupervisorOrTreating` and every
test of the matrix passed. No call site could reach it. `progressContext()`
built its target from the note alone — author and author's supervisor — so the
third claimant, the clinician who carries the client now, was never in the
target the matrix decided on. A policy cell that decides `true` against a
target nobody constructs is a comment.

The fix is one join on a query that already ran, and read, update, sign, cosign
and amend inherit it. `listProgressNotes` needed the other half: its SQL scoped
to `authorId IN (self, supervisees)`, so the list said no where the single read
said yes. The test for it was written first and then run against the file with
the join removed, to make sure it actually goes red. It did.

### The door the matrix refused

The PRD sketched `executeDeparture` as `guardedAll` over the records it
touches, the way a group session writes six clients' records. The matrix said
no. Admin's `client.update` is `breakGlass`, and a departure has no break-glass
cell anywhere in its column by design. The sketch had two possible
implementations. One was a practice manager breaking glass fifteen times on a
routine Tuesday. The other granted admin `client.update`, which is the widening
this feature exists to refuse.

What was exercised is `depart`, so `depart` is decided once, by `guarded`, and
logged once. Everything after it is a consequence and is logged with
`auditEvent` in the same transaction: one row per client (`departure:transfer`,
`departure:discharge`, `departure:referred_out`), per alert repointed, per
supervisee, per draft abandoned, per private note made unreachable, and one for
the deactivation. Each names the departure and the client where there is one,
and carries a code. It is the same register the purge set in §30, arrived at
from the other side: that one had no actor exercising a power, and this one has
exactly one.

### Postgres decides the hour

The PRD had `departureConflicts` validate the plan and then the transfer run.
That is a read-then-write check, and `booking.ts` already measured what one of
those costs: a session booked onto the receiver between the check and the move
slips through the window. So the roles split. The scan runs any time from
notice, using the same `tstzrange(…) &&` the exclusion constraint uses, so the
two cannot disagree about what a clash is. At execution the constraint decides.
A `23P01` anywhere in the move rolls back the entire departure and surfaces as
`Conflict('hour_clash')`.

The rollback test depends on write order. The writes a clash can refuse come
*after* a client row, an appointment cancellation and a series deactivation
have already gone through inside the same transaction. The test then asserts
none of those survived, nor the account change, nor the draft status, nor any
`depart` audit row. A rollback test whose failing statement is the first write
proves nothing.

The other blockers are checked inside the transaction, before any write:
undecided clients, a transfer to someone gone, an unread alert with nobody to
route it to, associates with no supervisor to take them. Those are facts about
the plan, not races with a neighbour. They all come from one
`departureBlockers` list, which replaces the PRD's four-function readiness
question (D-20).

### The two moments, and what cancelling puts back

Notice sets `acceptingNewClients = false`. Cancelling has to undo that, and
without a stored value "undo" means guessing `true`. Guessing `true` reopens a
clinician who had closed their own books, which puts the practice manager in
charge of a capacity signal that D-10 says they may only ever close. So the
departure row records the value it overwrote.

### The supervision tree

One `receivingSupervisorId` on the departure, not one per supervisee. A caseload
splits because clients follow the fit, the hour or the ending, and none of that
applies to associates. Splitting them across supervisors is restructuring the
practice, and belongs in `user.update`, not in someone's last day. The receiver
has to be someone the matrix would let co-sign. The first draft checked
`role === 'supervisor'` and the build failed it, correctly, under hard rule 1.
It now asks `may(… 'cosign' …)` for that person, so the answer stays right if
who may co-sign ever changes. A CHECK refuses the leaver as their own successor.
`coSignedById` is now `RESTRICT`, which changes nothing today, and that is the
reason for making it.

### What it deliberately does not do

- **Decide dispositions.** `DepartureAssignment` rows are written by the plan
  screen in Phase 4, under `departure.update`. This phase reads them.
- **Mark the clinician departing in the person picker.** P0-9's second notice
  effect is presentation, and it belongs to Phase 4 with the rest of the UI.
- **Move inactive clients.** The caseload is `status: 'active'`. A client
  discharged last year keeps naming the clinician they actually saw.
- **Batch the audit rows.** Around a hundred single-row writes for a
  fifteen-client caseload, inside a 30-second transaction budget. A
  `ponytail:` comment names `createMany` as the upgrade if a real caseload
  ever gets near that.

## 32. The screen, and what it may say

Phase 3 wrote the transaction and left three things for the screen: nothing
wrote a decision yet, the blockers came back as ids, and the practice manager's
path to a client's name is break-glass. The screen is mostly forms. The
interesting parts are the name it may show, the name it may not, and the hole
the first decision form opened in Phase 3's transaction.

### The name it may show

The plan is a list of clients, and the person who executes it holds
`client.read: breakGlass`. Resolving names through the client resource would
mean a practice manager breaking glass on a routine Tuesday, which is D-21's
wall met again from the read side. P0-3 had already answered it: a departure
plan is a client list at the demographic tier, the tier the calendar shows the
same manager through `appointment.read`. So `getDeparturePlan` returns names
and codes on `departure.read`, in one read with one audit row (D-24). It
returns nothing else. The test asserts the key set, so a date of birth added
for convenience later fails the build rather than widening a cell.

### The name it may not

An `unread_alert` blocker carries a client id, and the screen does not use it.
Front desk reads plans, and "this client has an unread risk alert" is a
clinical signal about a named person, routed by hard rule 9 to exactly one
clinician. So the screen gives a count, and says the leaver needs to read their
alerts before they go (D-25). That is also the correct fix: the one person who
knows why the alert fired is still here.

### The hole the form opened

`decideAssignment` is the only writer of `DepartureAssignment`, under
`departure.update`, one audit row per decision with the disposition as a code.
Deciding again replaces the decision, and the log keeps both. It refuses inside
the guard, so a caller the matrix turns away learns nothing about the caseload:
a client not on the leaver's active caseload, and a transfer to somebody who
could not carry the client. "Could carry" is asked of the matrix — would it let
this person write a note for a client of their own — because hard rule 1
forbids asking a role name.

Writing that first refusal exposed a Phase 3 bug. `executeDeparture` repointed
every assignment it was handed. A client front desk moved to another clinician
during the thirty days would be taken back from that clinician on the last day,
with an audit row saying it was the plan. Execution and the blocker scan now
read assignments through the live caseload (D-26). The test was run against
the old query and went red.

### The note only you can fix

Everything else on a departure can be fixed by somebody else later. An unsigned
draft can only be fixed by its author, before they leave. So a departing
clinician gets a strip on every page naming their last day, linking to their own
plan, where `ownDrafts` lists their drafts oldest first with the days left. It
is two rows through `guardedAll`: the departure under `self`, the drafts under
the `progress_note.read` an author already holds. No new cell. The strip and the
person picker's "leaving, last day …" marker come from the query the picker
already ran, so neither costs a request.

### What it deliberately does not do

- **Validate the receiving supervisor at notice.** `setReceivingSupervisor`
  refuses a receiver who could not co-sign; `planDeparture` still takes one
  unchecked, the form only offers supervisors, and the blocker scan catches a
  hand-rolled POST before execution.
- **Seed a departure.** The capstone demo needs one and the seed is shared by
  every e2e spec. `departure.spec.ts` records its own notice and withdraws it,
  in `afterAll` as well as in the last test.
- **Refuse a disposition outside the enum politely.** A hand-rolled POST with
  one is a Prisma error, as it is on the enquiry form.

## 33. What the practice sees around a departure

Phase 4 built the plan screen. Phase 5 is the P1 list: five small surfaces around
the plan, each one a read, plus one write inside the transaction. Most of it is
rendering. The work was deciding what each surface may say, and the answer was
nearly always a count.

### The work-list that is not a second plan screen

P1-1 asked for one screen that answers "is this departure ready?", and the plan
screen already does that. So `departureWorklist` is a section on `/worklists`:
each open notice, soonest last day first, with the blockers counted by kind, the
leaver's unsigned notes, the days left, and a link to the plan. It runs the same
`blockersOf` the plan uses, so the two cannot disagree, and it returns no client
id at all. The test asserts the whole row with `toEqual`, so a client id added
later fails it (D-28, which is D-25 applied to the whole list). Unsigned notes
sit beside the blockers rather than among them. They never stop an execution;
they become notes nobody may sign, so the countdown is what matters. The page
asks `may` before reading, because a clinician's `self` cell would otherwise
write a denial row on every visit.

### The message that does not say who

P1-3's example body read *"From 1 October your appointments are with Beth
Okoro."* No client message in this codebase names a clinician, and for a reason
the deny-list cannot enforce: a therapist's full name is one search away from
what kind of practice this is, and the practice has a separate messaging name
precisely so that a lock screen does not say that. The portal already shows who
each session is with, behind the client's own link. So `clinician_changed` says
the date of the first session that moved, that the day and time stay the same,
and links to the portal (D-27). The name is one tap away, and never in the body.

It is queued inside `executeDeparture`, never sent there. It commits with the
transfer or rolls back with it, and the test that proves this decides a clean
transfer before the clashing one, so a message is already queued when the
constraint refuses. Moved into its own transaction as a mutation, that test goes
red. Three clients get nothing:

- **`reminderPreference = 'none'`.** Not even a portal link is minted for them,
  because a door created for a message that will never go is a live token nobody
  asked for (mutation-checked).
- **A transferred client with nothing booked.** There is no schedule to tell
  them about, and a message about a change with no date is a message about the
  change itself.
- **Discharged and referred-out clients.** Their sessions are cancelled and
  nothing is sent. Learning from a text that a therapeutic relationship has
  ended is exactly what the PRD's scope note says software must not do.

### The marker, and the count, and the preview

- **P1-2.** `getClient` carries the executed transfers: from, to, and the date,
  under the same `client.read` and the same audit row as the rest of the
  demographics. The key set is asserted, so no disposition or reason reaches
  front desk. A plan that has not executed marks nothing (mutation-checked).
- **P1-4.** `abandonedNotesByDeparture` is a count per executed departure on the
  practice report, zeros included, on `departure.read`. The practice manager holds
  `progress_note.read` only under break-glass, and a number about a colleague
  leaving is not a read of anybody's record.
- **P1-5.** `previewProcessNotePurge` sits on `/practice` under the setting it
  depends on. For each departure it gives a count, how many the next run takes,
  and the date the rest go. It names no client: the only person who could say
  which clients they wrote privately about has left, and the preview should not
  say it for them (D-29). It reads the window through the same helper as
  `runProcessNotePurge` and keys on `authorId` the same way. The test runs the
  preview and the sweep on the day before and the day of, and they agree.

### What it deliberately does not do

- **Name the clinician in a client message.** D-27, above.
- **Message discharged clients.** Their cancelled sessions are a phone call.
- **Filter the abandoned-note count by the report's dates.** A departure is rare
  and the number is cumulative. The caption says so.
- **Seed a departure.** Owed to the capstone demo, which landed in §34.
- **Carry a real base URL into the link.** Every queued link in this codebase uses
  the stub's `localhost:3700`, because nothing sends.

## 34. A departure you can watch

The PRD's lagging metric is a demo, not a number: a therapist with fifteen
clients, three receivers, two discharges, one referral out, four unsigned
drafts, two unread alerts, and one hour clash planted on purpose. The run before
the fix changes nothing, and the run after it succeeds. Past the window, the
private notes are gone and the audit trail is not. Every piece already had a
unit test. What was missing was all of them at once, on a practice with a
history, through the production build.

### The seed had to stay out of its own way

The seed is shared by every e2e spec, and its PRNG sequence carries weight: one
extra draw in the client loop reshuffles every fixture after it. Dealing the
caseload out of that loop would have moved fixtures three files away, and
borrowing a seeded clinician would have moved counts other specs assert (Tom
Bergqvist's twelve, for one). So the leaver is a seventh therapist, Maren
Solberg, created at the very end of the seed. She draws nothing from the PRNG.
Her sessions sit at 9, 11 and 13. No standing slot uses those hours, so no
receiver has a clash anywhere except the one planted on Kai Oyelaran. Every
decision goes through `decideAssignment` on a fixed clock, and the notes and
alerts go through the real services. The audit rows are the ones the
application writes.

### The walkthrough executes, and cannot be undone

`departure-demo.spec.ts` is the first spec that deliberately leaves a mark.
`departure.spec.ts` withdraws the notice it gives, but this one cannot: the
execution is the point. `test:e2e` reseeds before every sweep. With one worker,
the specs before it see a planned departure and the specs after it see an
executed one, so a green sweep has tested both states. The steps:

1. Execute with the clash in place. The refusal is in words, and psql confirms
   all fifteen clients, the plan and the account are exactly as they were. Eleven
   transfers were written before Postgres refused the twelfth.
2. Send the clashing client to Dev Marchetti instead. The plan screen reads
   "Nothing in the way", and the same plan executes: 5, 3 and 4 clients to the
   three receivers, 3 inactive, 4 notes abandoned, 3 process notes unreachable,
   both alerts moved with their clients, and the account closed.
3. As the receiver, the whole signed history of a transferred client is
   readable, and nothing the leaver wrote privately appears.
4. The real `runProcessNotePurge`, on a clock seven years and a day ahead.
   Three notes and the amendment are gone, `departure:process_note_destroyed`
   appears three times, and the leaver's own audit rows are the same count as
   before. All 45 progress notes are still there.

### What it found: an early execution strands the weeks before the last day

The first run's assertion expected no open sessions left on the leaver. There
were 45. `executeDeparture` moves sessions from the last day on, and the weeks
before it belong to the leaver, who is still working. The demo executed on the
real date, twelve days before the seeded last day, so 22 of those sessions were
still in the future, sitting on an account the same transaction had just closed.
That is the silent half-moved state D-06 exists to prevent, reached by clicking
Execute early rather than by a clash. Nothing refused an execution before the
last day. The spec asserts what the code promises (nothing open from the last
day on).

**Decided and built as D-30: execution is refused before the last day.** The
alternative was to move from the earlier of now and the last day, which would
have had the clash scan flag weeks that only move if somebody clicks early. The
refusal is checked inside the guard, ahead of the other blockers: a supervisor's
early attempt is still a denial on the record, and a plan that is early *and*
unready is told about the date. The seed now gives notice three weeks before its
`TODAY` and leaves on it, so the demo executes on any real date after that.

### What it deliberately does not do

- **Call `purge:run`.** It sweeps enquiries too, on the same advanced clock, and
  the intake specs after this one still read them. The spec calls the one sweep
  it is about through `tsx`.
- **Walk every role to the process-note panel.** The refusals are asserted cell by
  cell in `permissions.test.ts` and in the confidentiality spec. After the purge
  there is no row left to refuse, and that is what the spec asserts.
- **Restore itself.** Running this file alone needs `npm run db:seed:e2e` first.
  The doc comment says so.

## 35. Three an hour, ten at once

§25 put an hourly ceiling on the public form and left a `ponytail:` comment on
how it claimed a slot: read the row, then write it. The comment priced the gap
at one extra submission and called that not worth a lock. A test that sends ten
at once from one address measured it instead. All ten got through a limit of
three.

The comment's arithmetic pictured two requests in flight. A script sends ten,
and for a submitter nobody has counted yet, every one of them finds no row and
writes a fresh window with a count of one. The ceiling held for a person
clicking twice and not for the thing it was built to stop.

### One statement, and the lock it takes

`claimSlot` is now a single `INSERT … ON CONFLICT (id) DO UPDATE … WHERE`. The
conflict path takes the row lock, so a burst queues on the row and each request
sees the count the one before it left. The `WHERE` is the refusal: a full window
that has not expired fails it, nothing is written, and `$executeRaw` reports no
row affected. The window reset moved into the same statement, as a `CASE` on
whether the window is spent. No migration: the table's primary key was already
the constraint the statement needed.

It is the answer `appointment_clinician_no_overlap` gave booking. When two
requests can disagree about what the database holds, the database decides, once.

### The zone the column does not have

`windowStartedAt` is a zone-less `timestamp(3)` holding UTC, and the local
session runs in `America/Chicago`. Prisma's own queries convert. Raw SQL is where
a five-hour shift would come from, so the first draft pinned each instant with
`::timestamptz AT TIME ZONE 'UTC'`. Then the tests ran with the pinning removed
and all of them still passed, so the pinning had no guard and possibly no
purpose. One assertion settles it: the window a claim starts, read back through
Prisma (which the purge also compares with), is the clock's instant. It passes
with the pinning and without it. The driver already sends a `Date` as the UTC
instant, so the pinning came out and the assertion stayed. It is what fails if a
driver upgrade ever changes that.

### What it deliberately does not do

- **Count refusals.** A refused attempt writes nothing, as before. A bot that
  keeps knocking is held at the limit rather than pushed further out, and the
  audit log already records every knock.
- **Slide the window.** Still a fixed hour, and the purge sweeps spent rows
  exactly as it did.
- **Span instances without a secret.** With no `CLEARPATH_THROTTLE_SECRET`,
  each instance keys its own hashes. That `ponytail:` stays. It is a deployment
  setting, not a race.

## 36. A reader with an end date

§29 moved a caseload because the relationship had ended. A clinician on leave is
coming back, so the same move is wrong on every line: repoint the treating
clinician and something has to repoint it back, and that restore is a guess
about what changed in between. Until this entry, an eight-week leave left
fourteen clients readable by nobody at work, apart from the practice manager
through break-glass.

### The grant is a function, not a row

Coverage adds a second reader and never touches the first. `Target` gains
`coverage` (which leave, which coverer, the dates) and `today`. Three rules add
the coverer to rules that already existed: `treatingCoveringOrSupervising`,
`authorSupervisorTreatingOrCovering` and `treatingOrCovering`. Five clinician
cells move to them. The coverer is `covers`: named on the target, not an
associate, and `leavePhase(coverage, today) === 'active'`. Nothing is written
on the first day and nothing is revoked on the last. On the 28th the same
function returns `ended`, whether or not anything ran.

The review moved one line of the draft. v0.1 had the caller set a bare
`coveringClinicianId` only on an active day. That made "is the leave on today"
an access decision taken outside `permissions.ts`, and it left the boundary
tests with only an id comparison to test. Now the caller resolves *which*
leave and *which* coverer, the way it resolves a supervisor, and the matrix
decides *when*.

`can()` now reports `coveringLeaveId`, and only when the same request without
coverage would be denied. A supervisor who happens to be named as coverer was
already a reader, and the audit row will not say they relied on a leave.

### What the mutations found

After the boundary tests passed, four guards were removed one at a time and
every removal turned tests red. One of them mattered more than it looked. Take
out `t.today !== undefined` and `leavePhase` gets `undefined` for today.
`undefined < '2026-10-05'` and `undefined > '2026-11-27'` are both false, so
the phase comes back `active` on every day. The guard that reads like
belt-and-braces is the only thing between a call site that forgot the clock
and a grant with no end date. A test pins it.

### What it deliberately does not do

- **Move a process note, in either direction.** Nour's stay `author` against
  the coverer, the supervisor and break-glass, on every day of the leave. Dev's
  own, written while covering, are Dev's after it.
- **Widen for anyone but the coverer.** The coverer's supervisor, and a front
  desk, admin or auditor account named on the row, get the same answer as
  without it. That property is asserted over the whole matrix.
- **Let a coverer read the plan they cover under.** `leave.read` stays `self`
  for clinicians. Dev learns what they cover from the caseload they can now
  read.
- **Resolve anything yet.** No schema, no `clientTarget` change. Until Phase 3
  wires the resolvers, no call site passes `coverage`, so the widening denies
  everywhere, which is what failing closed looks like before the wiring.

### Phase 2: the row the function reads

`Leave` and `LeaveCoverage` hold only what `covers` needs and what a person
decided: the dates, the coverer, per-client overrides, and `cancelledAt`.
There is no status column, and the one stored transition, `upcoming →
cancelled`, is a `TRANSITIONS` table in `leave.ts`. An active leave cannot be
cancelled, because it has already been a grant for at least a day. It ends by
shortening `toDate` to today, and the record keeps the days it was on.

The database refuses what is a fact about the rows. `leave_no_overlap` is a
gist exclusion on an inclusive `daterange`, so two leaves sharing even one day
are refused, and a cancelled leave's dates are free again.
`leave_calendar_row_while_live` is a biconditional: a live leave has its
`AvailabilityOverride` and a cancelled one has none. With `Restrict` on the
link, nobody can delete the calendar row out from under a leave. A CHECK stops
the person away covering their own leave. A per-client coverage row cannot
see the leave from a CHECK, so the same rule is a trigger there.

The service (`staff/leave-plan.ts`, kept out of `leave.ts` to avoid the import
cycle) refuses what only today can decide. A leave cannot be backdated, an
active leave keeps its first day, and an ended or cancelled leave is frozen.
The coverer check at the door asks the matrix, not a role name: `mayTreat`
and not `requiresCoSignature`. Then it asks whether that person is here for
the rest of the window: active, not leaving before it ends, and not away
themselves on any day still to come. Mutation-checked: removing the
co-signature check, counting the coverer's own leave from its first day rather
than today, or keeping a per-client row that duplicates the leave each turns a
test red.

Phase 2 writes nothing that grants anything yet. No resolver reads these rows
until Phase 3, so every call site still denies the coverer.

### Phase 3: the wiring

One lookup answers *which leave* and *which coverer* for every caller:
`coverageOf` in `staff/coverage.ts`. `clientTarget`, the progress-note context,
the caseload list and alert routing all ask it, so a split client cannot mean
Kai to the record and Dev to the alert. It takes the earliest leave that is
not cancelled and not over, which is the one under way when there is one, and
hands `covers` its dates. The day is still decided in `permissions.ts`. The
module imports only the database and `leave.ts`, because the repository, the
form service and the inbound handler all reach it.

**The caseload list** admits a covered client by asking `may` of that client's
resolved target, so the list names exactly the clients the record would open,
and the leave-level coverer never sees a client split to Kai. The scope moved
inside `AND`. Spread as a bare `OR`, it is overwritten by a search's own `OR`,
and Dev's search returns every matching client in the practice.

**Alerts.** Both creation sites call `alertRecipient`. It asks `leavePhase`,
the same function `covers` asks, so an alert reaches the coverer on exactly
the days the coverer can open the record behind it. The screener's email
follows the alert. The sweep, `runLeaveAlertSweep`, has no idea what a
boundary is. It puts every unread alert a leave touches where routing says it
belongs *today*. The first day, the day after the last, and a supervisor's
mid-leave decision are the same rule, and a second run writes nothing. The
run is one transaction, and each write in it is conditioned on the alert
still being unread with the same recipient. Each writes a `SYSTEM_ACTOR`
audit row naming the leave. It
runs on `reminders:run`, not `purge:run`. It has that runner's property
exactly: idempotent, and late rather than wrong when missed. Lateness is its
whole cost, and an unread critical alert should not wait for a nightly purge.

**The audit reason.** `guarded` writes `leave:<leaveId>` when the decision
rested on a leave and the action brought no reason code of its own. A treating
clinician's read of the same client on the same day writes `null`.

**The books** are `accepting = declared && !onLeave(today)`. The clinician's
own toggle reads `declared`, so Nour's "Open my books" button describes the
value Nour set, not the leave.

**`leave_open`** is a departure blocker while the leave has not ended.
Execution refuses with that code after D-30's date check, ahead of the generic
`departure_not_ready`.

**Back today** (D-18, settled in this phase). Phase 2 let `toDate` shorten as
far as today. The leave was then still on until midnight, so the "ends" alert
move P0-5 put in the edit had nothing to move. Nour, back at their desk, had
alerts going to Dev for the rest of the day. An early return now saves
`toDate` as yesterday. The leave has ended when the edit commits, so Dev's
next read is refused. The same transaction returns the leave's unread alerts
through `rerouteAlerts`, the helper the sweep uses, and the audit rows name the
admin who made the edit. A leave whose first day is today cannot end before
it, and runs to midnight.

Nine mutations, each turned red: the split row ignored, routing that ignores
the dates, no leave reason, the scope as a bare `OR`, a sweep that moves
acknowledged alerts, no `leave_open`, capacity not derived, an early return
that leaves the alerts with Dev, and the one that mattered most:

- **The coverer's whole-record note list asks `coveringLeaveId`, not
  `allowed`.** `listProgressNotes` widens its `where` for the coverer, the way
  it already did for the treating clinician. Asking whether the matrix allowed
  a read of somebody else's note is the obvious test, and admin's break-glass
  passes that cell. The obvious version handed the practice manager every
  progress note on the client. A test pins it.

### Phase 4: the screens, and the lived-through leave

**The plan screen** is one read and one audit row, `getLeavePlan`. Client names
ride on `leave.read`, as a departure plan's ride on `departure.read`: names and
codes at the demographic tier front desk already reads. The caseload shown is
the one still treated, plus any client this leave decided about who has since
moved on, so a split never drops silently off the record.

**P0-8's scan is the door's own question.** `unavailableCoverers` answers
"which of these people could not cover the rest of this leave" for any number
of people in three queries. `assertCoverer` asks it of one person when a
coverer is named. The plan screen asks it on every read, of each coverer the
leave names and of everybody else for the pickers. The screen therefore offers
exactly the people the write would accept, and a coverer who books their own
week off later shows as a blocker the next time anyone looks. A blocked coverer
is named without a reason: a colleague's leave or notice is theirs, the person
away reads this screen, and the fix is the same either way.

**D-19: a write moves its own alerts.** Phase 3 left one case to the hourly
sweep. After a supervisor split a client to Kai mid-leave, the matrix refused
Dev the record at once, and the alert behind it stayed with Dev until the next
run. `settleAlerts` now runs inside `createLeave`, `nameCoverer`,
`decideCoverage` and `editLeaveDates`. It hands this leave's unread alerts to
`rerouteAlerts`, the sweep's own helper. Phase 3's early-return branch became
this general rule, and the sweep went back to its one job: the date boundaries,
when nobody writes anything.

**Front desk's view** is `/leave`: who is away or about to be, until when, who
covers, and how many clients somebody else covers. **The markers** (P1-2) are
display only, because the matrix already decided which rows these are. The
caseload list says "you cover until" on rows the reader has only because they
cover them. The record says "Hana away until … · covering: Dev" at the
demographic tier, per client, so a split client names Kai.

**The audit log could not filter on what P0-9 wrote.** Every covered read said
`leave:<id>`, and the auditor's screen had no way to ask for it. The query
takes an exact `reason`, and a code-shaped reason in the table is a link to its
own filter. Only code-shaped ones are: a break-glass justification is free text
somebody typed, and free text never goes in a URL (hard rule 3).

**The capstone** is `leave-demo.spec.ts` over a seeded leave with its own
therapist, Hana, for the reason Maren has one. Nour's week of annual leave
stays a bare override, because `scheduling.spec.ts` reads it and P1-1 counts it.
The leave is dated from the real clock, not the seed's today, because the point
is a leave that is on while the specs run. It was recorded two days ago. The
screener landed on day two and the text on day three, each through the real
path on its own day's clock. The spec follows Dev from the alert to the
screener and both records, with no break-glass row. It shows front desk the
coverer client by client. Then it asks `getClient` for the day after the last
on an advanced clock, before anything has run: refused, while the unread alert
still sits with Dev, because access never waited on the sweep. The manager
brings Hana back today, and only the unread alert goes home. Last, the
auditor's `leave:<id>` filter lists Dev's reads, none after return, and no
audit row names Hana's private note with anybody else as the reader.

The spec's first draft asserted "no `process_note` read on these clients by
anyone but Hana", and it failed on a correct system. Dev's record page lists
Dev's own private notes on a covered client, filtered to Dev in SQL, and that
list is an audit row like any other. The rule is about whose note is read, so
the assertion has to name the note, not the client.

Four mutations, each turned red: no alert move in `decideCoverage`, none in
`createLeave`, the scan ignoring a coverer's own leave, and the caseload marker
shown to whoever reads the row rather than to the coverer.

### What Phase 4 deliberately does not do

- **No list of ended leaves.** An ended leave is the audit log's to tell, and
  the log can now be filtered by its id.
- **No reason for a blocked coverer**, as above.
- **No P1-1, P1-3, P1-4 or P1-5.** The uncovered-absence count, supervisor
  coverage, "while you were away" and the work-list section are each their own
  item.
- **No scheduler.** `reminders:run` still has nothing that runs it, so the
  boundary sweep runs only when invoked.

### P1-5 and P1-1: the leave section of `/worklists`

**The problem.** The plan screen answered "is this leave ready?" only for
someone who opened it. Nothing on front desk's daily screen said that a coverer
had since booked their own week off, or that a clinician about to go still had
unread alerts which would land on a colleague on day one. And an absence
recorded as a bare calendar row, with no leave behind it, covered nobody:
alerts went on arriving for a person who was not there, and no screen said so.

**The design.** `leaveWorklist` is `departureWorklist` again (departure D-28):
one row per leave not yet over, and counts only. It gives the caseload the
coverers take on, how many named coverers could not cover the rest (the plan
screen's own `unavailableCoverers`, so the two cannot disagree), and the unread
alerts still addressed to the person away. That last clause is `waitingWith`,
now shared with `settleAlerts`: exactly the alerts a leave moves on its first
day. On an upcoming leave it is a nudge to read them before going. On an active
leave it should be zero, and a number there means a sweep that has not run. The
unit test shows both, before and after the day-one sweep.

`uncoveredAbsenceAlerts` counts unread alerts whose recipient has an
`unavailable` override active today with no leave attached. Unread, because an
acknowledged alert has a reader. Today, because a future absence has not yet
left anyone waiting. It reads on `leave.read`, so its audit row is a read. The
screen shows it only to whoever holds `leave.create`, because recording a leave
is the fix (D-20).

Four mutations, each red once the test had a recipient whose absence begins
later: without the bare-override filter, the kind filter, the unread filter on
the leave count, or the today filter. The first version of the test missed that
last one. Its only future absence belonged to somebody who was also away today,
and `some` counts an alert once.

**What it deliberately does not do.**

- **No client, anywhere in either read** (departure D-25). The unit test checks
  the serialised rows for the client id, and the e2e spec checks the section
  for client codes.
- **No name on the uncovered count.** The absences section further down the
  page already says who is away. This line says that nobody covers them.
- **No capacity judgement.** The caseload count is shown and not compared to
  anything. Whether fourteen extra clients is too many is the practice's call.

### P1-3: a supervisor away, and who countersigns

**The problem.** Priya is an associate, and her signed notes wait in Rosa's
co-sign queue against a compliance clock. Rosa is away for eight weeks. A
clinician leave covers Rosa's own clients and nothing covers her supervision:
`supervises()` reads `authorSupervisorId` and nothing else, so the only person
who could countersign was the one away. D-17 held this back for its own review,
because the same function decides `progress_note.read` for every note a
supervisee has ever written.

**What the review found.** Supervision is two facts, not one. `supervises`
decides the note and the co-signature from the author's supervisor;
`supervisesTreating` decides the client, fee, attendance and screener from the
treating clinician's. For an older note those are different people, so the
cover could not ride on `coverage`, which hangs off the treating clinician. The
note read has no client bound, so a mirror hands the cover everything those
supervisees ever wrote. And six call sites found supervision by
`supervisorId: actor.id` or a hand-built target. Each would have denied the
cover: closed, and still broken.

**The design.** `Leave.coveringSupervisorId`, optional. Two `Target` facts,
`authorSupervisorCoverage` and `treatingSupervisorCoverage`, each carrying its
leave's dates, so the date decision stays in `permissions.ts` (D-14).
`coversAuthorSupervisor` and `coversTreatingSupervisor` require the supervisor
role and an active phase. The cells (D-21): `cosign` through a renamed rule,
`supervisorOfAuthorOrCovering`, and read on `progress_note`, `client` and
`form_submission` through the two covering rules, widened in place (D-23).
Those are a clinician coverer's reads, and none of their writes. `can()` strips
all three coverages to decide whether a leave made the difference.

Resolution follows the clinician case. `supervisionCoverageOf` sits beside
`clientTarget` and `progressContext`. `supervisionCoveredBy` feeds the lists:
the co-sign queue, which takes one guarded read per leave so each audit row
names its own; the caseload; and the note list. Each list filters through
`can` on the cell it serves. The note page asks `mayCoSign`, which uses the
co-signature's own target. The door refuses a leave for anybody who supervises
without a cover (`supervision_uncovered`), and anybody `maySupervise` refuses
as the cover. The plan screen scans the cover on every read (D-22).

Three mutations, each one red test: without the supervisor-role check; with
supervision coverage left on the target when attributing the leave; and with
notes read through the treating supervisor's cover instead of the author's.

**What it deliberately does not do.**

- **No associate coverers** (D-24). D-13 stands, because the fix widens a third
  relationship and reverses a pinned denial.
- **No per-client split of supervision.** One cover per leave; a supervisee
  split across supervisors is a rota.
- **No alert routing.** Supervision routes none, so a departure executed while
  the leaver's supervisor is away still hands its unassigned alerts to the
  supervisor who is not there. Rare, and listed under the PRD's risks.
- **No claim about licensure.** Whether a cover may countersign for somebody
  else's associate is a board's question.
- **The note list's audit row names the first leave a cover holds**, whether or
  not that leave's supervisees wrote on the client (`ponytail:` in
  `listProgressNotes`). Exact attribution is a count per leave.
- **No work-list count** of blocked supervision covers. The plan screen shows it.

### The scheduler: Vercel Cron for `reminders:run` and `purge:run`

**The problem.** Both runners were commands with nothing to call them on the
deployment. The leave boundary sweep rides on `reminders:run`, so an alert
stayed with somebody away until a person typed the command. `/worklists` now
has a count of unread alerts not yet moved, and a missing sweep looks exactly
like that count. The purge's retention windows were a promise nothing kept.

**What the design does.** `src/jobs.ts` states each runner once, as
`remindersRun` and `purgeRun`. The npm scripts call them, and so do two route
handlers under `app/api/cron`. `vercel.json` schedules reminders hourly and the
purge daily at 08:00 UTC. Each route admits only `Authorization: Bearer
$CRON_SECRET`, compared over digests so it runs in constant time, and it
answers with counts. With the secret unset, every call is refused. That
matters, because otherwise the literal header `Bearer undefined` would match an
unset secret.

**What it deliberately does not do.**

- **No `delivery:run` or `nonresponse:run`.** `nonresponse:run` has money
  attached and was built to be stopped on its own. `delivery:run` is the
  carrier stub, the only thing that moves a message to `delivered`, and fees
  depend on that state. Scheduling either one is a decision, not wiring.
- **No audit row for a refused cron call.** It has no actor and reads no
  record. It gets the same treatment as a request with no session.
- **No `maxDuration`.** Both runners are idempotent, so a run cut off by the
  platform limit is finished by the next one.

### P1-4: while you were away

**The problem.** Nour comes back after eight weeks. Dev opened screeners, held
sessions and wrote them up, and all of it sits on Nour's record. Nothing told
Nour which parts. The boundary sweep returns only the alerts Dev left unread,
and an acknowledged critical screener records only that Dev read it.

**The design.** `whileYouWereAway` finds the person's own leave that ended in
the last 14 days and lists three things from its window: submissions on their
caseload flagged for review, sessions somebody else held, and progress notes
somebody else wrote about sessions in the window. There is no new cell. Each
list is one request in a `guardedAll` over `form_submission`, `appointment` and
`progress_note`, with the target `{ clinicianId: actor.id }`, and each query
filters on `treatingClinicianId` in SQL, so the target and the rows cannot
disagree. The result is three audit rows in one transaction, none naming a
leave, because none rests on one. `recentlyBack` is the cheap half. Home asks
it and sends a returning clinician to `/worklists` instead of `/calendar`. It
asks the matrix first, because a leave can be recorded for somebody with no
caseload, and that person should get nothing rather than a denial on every
page load.

Two details decide whether the lists are right. Submissions filter on the
request's `submittedAt`, because a submission's `createdAt` comes from the
database's `now()`, not the injected clock. And "somebody else" means anybody
but the clinician, not the named coverers, because a split undone mid-leave
still held its sessions.

Six mutations, each red: removing the review flag, the window's end, either
"somebody else" filter or the matrix gate, and lengthening the fortnight by a
day. The two "somebody else" mutations were green at first. Nour's own fixture
session sat before the window, where the date filter already excluded it. It
now sits inside the window, as a session taken from home.

**What it deliberately does not do.**

- **No process notes, and no count of them.** What Dev wrote privately is
  Dev's (D-05), and a count would say that it exists.
- **No dismissal.** Nothing is written on return, and the section goes after
  a fortnight (D-25).
- **No alerts.** Nour's unread ones are already on `/alerts`. Who acknowledged
  the rest is the recipient's record, and Nour holds no cell on it.
- **Nothing for a returning supervisor.** Co-signatures a supervision cover
  gave are not listed. P1-4 is the treating case the PRD names.
- **No client names.** Codes, the form's name and dates only. The links open
  each record through its own guard.

### A departure while the supervisor is away

**The problem.** Departure P0-7 hands a leaving clinician's unread alerts to
their supervisor when the client has nobody to receive them. If that
supervisor was on a leave with a supervision cover, the alert went to the
person away. The sweep could not repair it. It routed by the client's treating
clinician, so the leave's end would have sent the alert back to the closed
account, and it skipped alerts a departure had passed on for that reason. The
same gap opened in the other order, a supervisor's leave starting after the
departure. A new alert about that client went to the closed account as well.

**The design.** Routing learns one fact: whose an alert is when nobody is away.
`ownerOf` answers with the treating clinician, or, once they are inactive,
their supervisor. `routesOf` then covers the owner. A clinician is covered by
client, through `coverageOf`. A supervisor is covered by supervision, through
`supervisionCoverageOf`, the fact `clientTarget` grants the cover's read on, so
the alert reaches the cover on exactly the days the cover can open the record.
Every path calls it: alert creation, `executeDeparture` (routing the client as
it stands once the transaction commits), the sweep, and each write that settles
a leave's alerts, now including `nameSupervisionCover`. The stamped
`coveringLeaveId` is what brings it back to the supervisor. A transferred
client's alert reaches an away receiver's coverer the same way, in the
departure's transaction rather than at the next sweep.

Three tests, one per order plus new alerts, and five mutations, each red: the
departure ignoring the cover, the sweep's old treating-clinician filter, the
old `waitingWith`, `nameSupervisionCover` not settling, and `ownerOf` answering
with the treating clinician.

**What it deliberately does not do.**

- **Nothing for a supervisor away with no cover.** The alert stays with them.
  The door requires a cover for anybody who supervises (D-22), and the plan
  screen flags a missing one.
- ~~**Nothing for a supervisor who departs later.**~~ Closed by §37. Alex's
  `supervisorId` repointed to the receiving supervisor, and the alert about
  Alex's client stayed with the supervisor's closed account, because their
  departure moved only their own caseload's alerts.
- **No new cell.** Routing asks no matrix question; the read the cover needs
  is P1-3's (D-21).

## 37. The alert the second departure could not see

**The problem.** §36's last bullet, found by reading it. Alex departs, a
discharged client's unread alert goes to Alex's supervisor Sam, and the client
row still names Alex. When Sam departs in turn, `executeDeparture` walks Sam's
*assignments* — the clients Sam treats — and moves each one's alerts beside the
disposition that moved the client. That client is not on Sam's caseload and
never was, so the loop never saw the alert. Sam's account closed with an unread
risk alert addressed to it, three lines after the supervision repoint had
already said, in the data, who now answers for Alex.

**The design.** The move comes out of the loop. Alerts are rerouted once, after
the caseload has moved, the supervisees have repointed and the account has
closed — every unread alert still addressed to the leaver, routed by
`routesOf`. The gain is that there is nothing left to project: the previous
version built a synthetic "the client as it will stand" for each assignment,
and the synthetic client was the bug, because it could only be built for a
client the loop knew about. Reading the practice after the writes gives a
transferred client's alert to the receiver, a discharged one's to the leaver's
supervisor, a departed supervisee's client's to whoever now supervises them,
and each of those to a cover while that person is away — the same four answers,
from one query instead of a projection per client.

The blocker scan is the same question thirty days early, where a projection is
unavoidable because nothing has been written. `afterDeparture` applies the
three moves the departure will make to one client's routing facts, `routesOf`
says where the alert would land, and `strands` asks whether that is nobody: the
leaver, or the client's own treating clinician once they have departed with
no supervisor above them. That is wider than the test it replaces — "the leaver
has no supervisor" — and, more usefully, *resolvable* where the old one was
not. An inherited alert used to block a departure with nothing on the screen
that could clear it. Naming a receiving supervisor now clears it, because that
is genuinely who takes it.

Two tests, one per outcome, and the P0-7 trio still green through the rewrite.

**What it deliberately does not do.**

- **Move a coverer's stamped alerts.** If the leaver holds an alert only
  because they cover somebody else's leave, routing still names them and the
  scan blocks. The fix is on that leave — name another cover, or end it —
  which is `leave_open`'s reasoning applied to a leave that is not the
  leaver's. Choosing who covers is a decision, not a route.
- **Acknowledge anything.** A read alert stays with the person who read it,
  as in §31. Only unread ones move.
- **Add a blocker kind.** `unread_alert` already said "this alert has nobody";
  what changed is the question that decides it.

## Decisions log

| Decision | Why |
|---|---|
| `progress_note.read` widens to include the treating clinician | It was the one clinical resource narrower than the record around it — a clinician could read their new client's risk scores and not the notes explaining them |
| The widening is a matrix cell, not a grant inside the transfer | The answer to "who can read this note" has to stay in the one file that is supposed to answer it; a transfer-time grant would have been narrower and unreviewable |
| The rule is called `authorSupervisorOrTreating`, not `recordReader` | Every other rule names a relationship; the name also lands in the audit row, so at both call sites the useful question is *who exactly* |
| `process_note` is untouched by all of it | The record transfers because it is the practice's record of care; the private notes do not because they were never part of it — one sentence, both answers |
| `depart` is its own action, not `user.update` | Admin already holds `user.update`; this one moves fifteen clinical records to new readers and schedules a destruction. Third time after `waive` and `discard`: a power nobody named is a power nobody reviewed |
| A supervisor may `update` a departure and never `depart` | Proposing who takes which client is what supervision is for; deactivating an account is the practice manager's act |
| No break-glass cell anywhere in the `departure` column | It holds a client list at the demographic tier and no clinical content — and a cell that exists "just in case" is one somebody eventually uses |
| Both departure endings are terminal | An executed departure moved a caseload; a withdrawn notice given again is genuinely a second notice on a second date, and the audit log should show two |
| The README's pictures are captured by a spec, not pasted | A screenshot has no mechanism for becoming false; captured by a spec it cannot drift without the capture breaking first |
| Queue rows are located by the note's own link, never by client name | A client can have two notes in the queue, so `.first()` silently acts on whichever the ageing order puts on top — it co-signed the wrong note in the capture and hid a hole in the walkthrough spec |
| One open departure per person, as a partial unique index | A plain unique says a person may only ever leave once, which forbids the P2 returning-clinician case; what is actually true is that two plans may not be in flight |
| A transfer must name its receiver, biconditionally | A `transfer` with no receiving clinician is the silent remainder goal 2 refuses, and a receiver on a discharge names a colleague taking nobody |
| A referral destination is only one-directional | A destination on a discharge describes a referral that did not happen; a `referred_out` with none is an honest row about a practice not in the contact list |
| `abandoned` is reachable only from `draft`, in the trigger | Without that clause the status becomes a way to retire an inconvenient signature — the one hole this feature must never be able to make |
| The enum value ships in its own migration | Postgres forbids using a newly added enum value in the same transaction, and Prisma wraps each migration in one — the CHECK that names it would fail on deploy, not in review |
| `NoteAmendment.processNoteId` becomes `Cascade`, and append-only grows one hole | An amendment carries its own content, so `SetNull` destroyed the note and kept the words; the hole is stated as what it is — a child of an already-unreachable note |
| The process-note window ships at seven years | Erring long and erring short are not symmetric: those notes are the clinician's own defence in a complaint made two years later |
| The sweep is driven from executed departures, not from `unreachableSince` | It is the only shape that can name `authorId` in the SQL, which hard rule 2's grep enforces — and it makes reaching a still-present author's note impossible rather than unlikely |
| The sweep logs with `auditEvent`, never `guarded` | No cell in the matrix lets anybody but the author touch a process note, and inventing one so a sweep could use the front door is the widening the feature exists to refuse |
| The audit page's user lookup is asserted to have no filter | `active = false` is the last thing a departure does, and a tidy-minded filter there would blank the trail of the person most likely to be under review |
| The demo's refusal is triggered last, after the locked panel | Frame five has to show the grant and the refusal together; taken in the obvious order the only refusal in frame was the seed's, minutes older than the story |
| The seed constructs the demo client's draft note explicitly | 85% of seeded notes get signed, so the frame-one draft would be lost to a seed tweak nobody connected to the README |
| The ambiguous `read process_note · allowed` row stays in the picture | It is a supervisor reading her own empty list, and a reader who spots it and finds no explanation has reason to distrust every other frame |
| The audit log records the request and outcome, never the rows returned | Distinguishing "read her own" from "read Priya's" would put the subject of a process note in the trail; the ambiguity is the cost of the ids-only rule, not a defect in it |
| No pixel-diff assertion on the captures | A seeded practice with a database-clock timestamp fails for reasons nobody reads; the timestamp column is masked so a human diff of the PNG is the signal instead |
| `Referrer` is one table for referrals in and referrals out | The same six surgeries seen from two sides; two tables would hold the relationship twice and let the spellings drift |
| `public` holds no cell on `referrer` | An enquiry is one row on a retention clock; a directory entry is a permanent shared string every future call and report reads |
| The source/entity agreement is a database CHECK, not a validator | The seed and any future writer bypass the service; a rule that lives only in the module everybody is supposed to call holds until somebody does not |
| The service drops a mismatched referrer instead of throwing | A no-JavaScript form cannot hide the picker when the source changes, and a `Conflict` there is a 500 on an ordinary change of mind |
| Referrers are retired with `active`, never deleted | Enquiries and past reports point at them; a surgery closing its list in June is not a reason to rewrite March |
| `Client` gets no copy of the referrer | The converted enquiry is retained forever, so the fact is already reachable; a second column is a second thing to keep in step |
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
| A `public` role in the matrix, not a guard bypass for anonymous writes | "What can an unauthenticated request do to this database" must be answerable from one file; as a bypass it is answerable only by auditing every route |
| The public cell's rule is `unconditional`, not `always` | `always` means "any actor in this role", and every other role holding it was hired; two identical functions, two different claims, and the audit row records which decided |
| The public cell has `create` and no `read` | Without a read anywhere in the anonymous row, the form cannot become a client-list oracle — guaranteed by the matrix rather than remembered by each surface |
| The public form has no free-text field | `Inquiry.note`'s mitigation is that a human hears it and types "prefers mornings"; a public textarea is that field with the human removed |
| Throttle rows keyed by HMAC of the address, never the address | A bare hash of an IPv4 is recoverable in minutes, which would make the anti-abuse table the biggest disclosure in the schema |
| Validation before the throttle, honeypot after it | A real person's typos must not spend their hour's allowance; a robot's attempts must |
| `publicInquiryEnabled` ships `false` | Deploying the route is not the same as consenting to run an unauthenticated write endpoint, and a flood needs a switch rather than a deploy |
| `Inquiry.takenById` nullable, pinned to `ON DELETE RESTRICT` | The null means "nobody took this call"; Prisma's default `SET NULL` would manufacture that meaning whenever a staff account was deleted |
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
| Capacity is its own resource, not an `update` on `user` | `user.update` is roles and supervision; a clinician reaching their own capacity through it reaches their own role. One boolean about oneself gets its own cell, for the reason `discard` is not `delete` |
| The practice manager reads capacity and cannot set it | A manager who can mark a clinician open has changed the signal from what that clinician can carry into what the practice would like, and overwritten the only record that somebody disagreed. Removing a departing clinician is `user.update`; declaring somebody has room is a different act |
| `setCapacity` takes no subject id | A parameter naming who to set would be a second way to express the one case the matrix exists to refuse. The actor is the subject, and the form has no hidden field either |
| Capacity is declared, caseload and queue depth are measured | A declared boolean changes when the clinician decides it changes. A declared number is wrong by Thursday, and front desk would believe it — so the counts come off rows that already exist, through a filtered relation count and no column |
| A closed clinician can still be assigned a call | A caller who asked for Alex by name belongs with Alex. A hard block teaches one behaviour — flip the boolean to get past it — which destroys the signal for everybody. `no_capacity` was already the honest ending |
| Assignment reuses `update` on `inquiry` rather than adding an `assign` action | Deciding where a call goes is the same category as declaring one dead, and P0-4 already put that cell with front desk and the practice manager. A clinician cannot assign one to themselves, which is the same rule read from the other side |
| `assignedClinicianId` is separate from `requestedClinicianId` | One is what the caller said, the other is what the practice decided. Collapsing them loses the case worth seeing: the call sent somewhere other than the name that was asked for |
| The page decides what to draw with `may(… 'capacity', { subjectUserId: actor.id })` | "Is this person a clinician" is not a question a page may ask (hard rule 1). "May this person declare their own capacity" is, and only one of the two stays correct when the matrix changes |
| The purge's candidate query is one `OR` of per-reason cutoffs, not five separate queries | `purgeWhere` still runs once, for the same reason `purgeCutoff` used to be shared between the purge and its preview: two computations that must always agree are one of them one edit away from silently not |
| The widening needed a join, not a rule | `authorSupervisorOrTreating` was correct and unreachable: `progressContext` never resolved the treating clinician, so the matrix decided against a target nobody built. One select, five call sites |
| Execution is one `guarded` `depart` plus `auditEvent` per consequence, not `guardedAll` (D-21) | Admin's `client.update` is break-glass and a departure has none. The two ways to satisfy `guardedAll` were fifteen break-glass sessions or the widening the feature refuses |
| The constraint decides hour clashes at execution; the scan is only the preview (D-22) | A read-then-write check has a window, and `booking.ts` already measured it. The scan and the constraint use the same `tstzrange &&`, so they cannot disagree about what a clash is |
| One blocker list, not `departureConflicts` (D-20) | P0-7 and P0-8 each add a blocking item. Readiness is one question, and a screen that asks four functions will eventually ask three |
| Notice stores the capacity value it overwrote (D-23) | Cancelling without it guesses `true`, which reopens a clinician who had closed their own books, a signal D-10 says the manager may only close |
| Plan names ride on `departure.read`, not `client.read` (D-24) | Admin's client read is break-glass; P0-3 already put a client list at the demographic tier in this cell. Names and codes only, asserted by key set |
| The unread-alert blocker is a count, never a client (D-25) | Front desk reads plans, and an unread risk alert on a named client belongs to one clinician. The fix is the leaver reading it, which needs no name |
| A decision is refused at the door; execution moves only who is still on the caseload (D-26) | Phase 3 repointed whatever it was handed, so a client reassigned during the thirty days would have been taken back on the last day |
| The transfer message links to the portal and never names the clinician (D-27) | A therapist's full name is searchable and the deny-list cannot catch a name; the portal already shows it behind the client's own link |
| The departure work-list is counts and a link, not a second readiness screen (D-28) | The plan screen already answers readiness and is the one place clients are named; counts keep a shared page from naming anybody |
| The process-note purge preview names departures, never clients (D-29) | Which clients a departed clinician wrote privately about is something only that clinician could have said |
| A form field in a page never takes the id `userId` | The dev switcher in the sidebar owns it on every staff page. The duplicate pointed "Who is leaving" at the identity switcher, and only a spec selecting by label noticed |
| Refusals travel back as a `Conflict` code, never its message | The code is the page's whole vocabulary, and a URL is no place for anything a person typed or a record holds |
| The receiving supervisor is checked with `may(… 'cosign' …)`, not a role | The first draft compared `role === 'supervisor'` and hard rule 1's grep failed the build. The matrix is the only place that knows who can co-sign |
| The demo's leaver is a seventh therapist added at the end of the seed | The seed's PRNG sequence carries weight, and other specs assert seeded caseload counts. A clinician who draws nothing and holds hours no standing slot uses moves nothing else |
| Execution is refused before the last day, inside the guard and ahead of the other blockers (D-30) | Sessions move from the last day on and the account closes whenever execution runs, so an early click left the weeks between on a clinician who could no longer sign in. Before the guard, a supervisor's early attempt would have come back as a date refusal with no denial row |
| The throttle claims a slot in one `INSERT … ON CONFLICT DO UPDATE … WHERE` | Read-then-write let ten simultaneous requests through a limit of three, not the one extra its comment priced. The row lock queues a burst, and the table's primary key was already the constraint it needed |
| Whether a leave is on today is decided in `permissions.ts`, from dates on the `Target` (leave D-14) | A resolver that sets the coverer only on an active day makes a date-shaped access decision outside the one file hard rule 1 allows. The caller resolves which leave and which coverer; the matrix decides when |
| A supervisor's `leave.update` is a grant, and they keep it (leave D-15) | Who covers which client is clinical fit, which is supervision's work. A departure has admin's `depart` between proposal and access and a leave has nothing, so the audit row is the control |
| Five cells' audit rule names change for every reader, not only the coverer | `client.read` and `form_submission.read` now record `treatingCoveringOrSupervising`, `progress_note.read` records `authorSupervisorTreatingOrCovering`, and both creates record `treatingOrCovering`. The name is the enumeration of who could have read, and a claimant arriving without renaming it is what D-15 said a register exists to stop. Whether a read actually relied on a leave is `coveringLeaveId`, not the name |
| `Leave.overrideId` is nullable, with a CHECK that it is set exactly while the leave is not cancelled | P0-7 says cancellation removes the calendar row. A required column would keep a cancelled leave blocking weeks the clinician is at work. A nullable one with no CHECK would allow a live leave that front desk can book straight through |
| The per-client coverer rule is a trigger, not a denormalised `userId` on `LeaveCoverage` | A CHECK cannot see the leave. A copied column with a composite foreign key would work too, but it adds a column whose only job is to be compared. `Leave.userId` is never updated, so the trigger reads a stable fact |
| A leave cannot be backdated, and an active one cannot be cancelled | The row records which days a colleague could read this caseload. A leave that starts last week, or one that vanishes after being on, claims reads nobody could have made, or erases reads that were made |
| The coverer's own leave counts against them only from today | A week off that already ended does not stop somebody covering the rest of a colleague's leave. Counting from the leave's first day refused a coverer for days already behind them |
| Naming the leave's own coverer for a client deletes the override row | "There is no row for same as the leave" (P0-1) is kept by the write, so changing the leave's coverer also removes rows that now duplicate it. A copy would go stale the next time the leave's coverer changed |
| `covers` refuses an associate even when a row names one | The write will refuse the row (D-13). Refusing again at read time means the rule does not rest on the write having run |
| One coverage lookup, `staff/coverage.ts`, for record reads, the caseload list and alert routing | A split client resolved in two places can mean one coverer to the record and another to the alert. It imports only the database and `leave.ts`, because the repository, the form service and the inbound handler all reach it |
| The leave alert sweep runs on `reminders:run`, not `purge:run` (leave Phase 3) | It is idempotent and late rather than wrong when missed, which is that runner's contract. Lateness is its only cost, and a nightly purge would leave an unread critical alert with somebody away for most of a day. `purge:run` shares a schedule because its sweeps destroy data |
| The sweep reconciles every unread alert a leave touches to today's routing, rather than acting on boundary days | The first day, the day after the last, and a mid-leave coverage decision become one rule. A missed run is caught up by the next, and a second run writes nothing |
| The caseload list admits covered clients through `may` on each resolved target | A `where` that re-derived coverage would be a second statement of the rule, and it could name a client the record refuses |
| The coverer's whole-record note list asks `can(...).coveringLeaveId`, not `allowed` | Break-glass passes the same `progress_note.read` cell, and asking `allowed` gave the practice manager every note on the client |
| Capacity returns `accepting` (derived) and `declared` (the clinician's toggle) | Front desk reads the first. The clinician's own button must describe the value they set, or "Open my books" during a leave writes a value that changes nothing on screen |
| A departure over an open leave refuses with its own `leave_open` code | The fix is one edit on a different screen. `departure_not_ready` would send the admin looking through a plan that has nothing wrong with it |
| "Back today" saves `toDate` as yesterday, and that edit returns the leave's unread alerts (leave D-18) | Shortening only to today left the leave on until midnight. The edit had no alerts to return, and a clinician at their desk had theirs going to a colleague all day. Ending the leave at the edit stops access and alerts together, when a person says so |
| The leave plan screen offers only coverers the write would accept, from the function the write asks (leave P0-8) | Two statements of "who can cover" drift. One function asked at the door, on every read and for the pickers means a picker cannot offer somebody the write refuses, and a later conflict shows up on the next read |
| A blocked coverer is named without a reason | A colleague's own leave or notice is theirs, and the person away reads the plan screen. The fix, naming somebody else, is the same whatever the reason |
| Leave writes move their own unread alerts (leave D-19) | A mid-leave split refused Dev the record at once, while the alert behind it waited for the hourly sweep. The sweep keeps the date boundaries, when nobody writes |
| The seeded leave has its own therapist, dated from the real clock | Converting Nour's annual leave would break `scheduling.spec.ts` and put the specs' therapist under coverage mid-sweep. A leave dated from the seed's fixed today would never be on while the specs run |
| The audit log filters on an exact reason code, and links only code-shaped reasons | P0-9 wrote `leave:<id>` so an auditor could list one leave's reads. A break-glass justification is free text, and hard rule 3 keeps free text out of URLs |
| `orBack` lives in the shared plan UI module, not in an actions file | Every export of a `'use server'` file is a callable endpoint. Sharing the helper from the actions file would have published it |
| The seed walks past sessions in a total order, `(startAt, client code)` | Standing sessions share start times across clinicians, and the PRNG's rolls are dealt in query order. Ties broken however Postgres chose made a different history on each run; once, two later sections both asked about one session, and the seed crashed on a duplicate reminder row. Client code is deterministic, and a client never holds two sessions at one instant |
| Vercel Cron calls the runners through `/api/cron/*`, and the scripts and routes share `src/jobs.ts` | Two doors that each list their sweeps drift apart, and the door that drifts is the one nobody watches. The route refuses without `CRON_SECRET` rather than trusting a header a platform might not send |
| A supervisor's cover gains co-signing and the three reads a co-signature needs, and nothing else | A countersignature given without the note, the record and the screener is signed blind, which `treatingOrSupervising` exists to prevent; fee, attendance and portal links run a caseload |
| Supervision coverage is two target facts, not one | A note's author and a client's clinician can answer to different supervisors, and each cell's grant has to follow the relationship that cell decides on |
| `supervisorOfAuthor` became `supervisorOfAuthorOrCovering` rather than widening in place | The rule name lands in the audit row, and a name that no longer says who is a name nobody reviewed |
| "While you were away" is on `/worklists` for 14 days after the last day, and Home lands there (leave D-25) | A dismissal is a write and a stored state for a list that goes stale by itself. Home is the first screen a clinician reaches, so its redirect makes this the first screen back without a second list on `/calendar` |
| The away summary filters submissions on `FormRequest.submittedAt`, not `FormSubmission.createdAt` | `createdAt` is the database's clock, so on a fixed test clock every submission lands on the day the suite ran (hard rule 7) |
| An alert belongs to its treating clinician, or to a departed clinician's supervisor, and a leave covers whoever it belongs to (leave D-26) | The sweep routed by treating clinician, so ending a supervisor's leave would have returned a departed clinician's alert to a closed account; one owner function makes creation, departure and the sweep agree in either order |
| Routing to a supervision cover reads `supervisionCoverageOf`, the fact the cover's client read rests on | An alert is only useful on the days its reader can open the record behind it, so routing and reads share one fact |
| A departure reroutes every unread alert the leaver still holds in one pass after its writes, not per client inside the disposition loop (departure D-31) | The loop only knew the leaver's own caseload, so an alert inherited from a departed supervisee stayed with the closed account; after the writes there is nothing left to project |
| The unread-alert blocker asks routing where each alert would land after the departure, and blocks when that is nobody | "The leaver has no supervisor" missed an inherited alert whose owner is somebody else's supervisor, and blocked ones the plan screen had no way to clear |

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
