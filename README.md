# Clearpath — Clinic Operations for a Counseling Practice

Operations software for a small group counseling practice: recurring sessions
across shared therapy rooms, layered confidentiality, supervision workflows,
scored intake screeners, and a tamper-evident audit trail.

Sample practice: **Stillwater Counseling** — 6 clinicians (2 licensed
supervisors, 3 licensed therapists, 1 pre-licensed associate), 4 therapy rooms.

---

## ⚠️ Scope Honesty (read first)

This is a **learning project with synthetic data only**. It applies HIPAA-*inspired*
design principles — least-privilege access, audit trails, no PHI in logs/URLs, and
the psychotherapy-notes distinction — because they're excellent engineering
discipline. It is **not** HIPAA-compliant software and must never hold real client
data. Mental-health data is among the most sensitive that exists; modeling the
protections is the lesson, claiming them would be the credibility-killer.

**Nothing sends and nothing charges.** Every message is a row in an outbox table
handed to a *simulated* carrier, and every fee is a flag on an appointment that
no payment processor sees. The carrier is a real seam — a `Carrier` interface,
delivery receipts, retries and failure codes — with the only shipped driver
being an offline stub, because a real credential here would mean real messages
to real handsets from a project whose first promise is that it holds nothing
real. The automatic no-show fee — a client who never answers three
reminders is marked absent and billed — is a *modeled mechanism*, built to show
what such a rule costs and what it has to refuse. It is not clinical advice, not
legal advice, and not a policy recommendation: the write-up argues at length
that a practice should ship the loop, watch a quarter of data, and only then
decide whether to turn the money on.

---

![The calendar as the front desk sees it: five columns of named sessions with times, rooms and clinicians, and a banner reading "Operational — names, times and rooms. Why anyone is here does not appear on this screen at any level of detail."](docs/screenshots/calendar-front-desk.png)

---

## The access rule that shapes everything

Two classes of clinical note, with different rules:

| | `progress_note` (the official record) | `process_note` (private working notes) |
|---|---|---|
| Author | read / write / sign | read / write |
| Supervisor of author | read + **co-sign** | **403, always** |
| Treating clinician (not author) | no | no |
| Practice manager (admin) | read via logged **break-glass** | **403, always — break-glass does not reach it** |
| Front desk | no | no |
| Auditor | no (sees the access event, not the content) | no |

![The panel a supervisor gets where their supervisee's process notes would be, explaining that process notes are visible only to their author — supervisors, the practice manager and break-glass included — and that this is a rule of the practice, not a permission you are missing.](docs/screenshots/process-notes-locked.png)

A refusal is a sentence, not a 403: what the reader gets is the rule and where
the official record is instead.

Every one of those cells is asserted in [`src/auth/permissions.test.ts`](src/auth/permissions.test.ts).
Authorization happens in exactly one place — [`src/auth/permissions.ts`](src/auth/permissions.ts) —
and a test greps the rest of `src/` to prove no endpoint re-implements a role check.

## Known limitations (deliberate)

- **No real auth.** A dev-mode user switcher stands in for login. Two-factor and
  session management are their own project. The *policy* — which roles would sit
  behind a second factor — is written and tested in `permissions.ts`, and the
  person picker marks those roles, so the seam is visible rather than implied.
  Nothing enforces it, because a check that always passes reads as a control.
- **No insurance billing.** The superbill exports completed sessions with their
  CPT codes and the fee recorded at the time of service, which is what a client
  needs to claim reimbursement themselves. It carries no diagnosis code —
  Clearpath does not model diagnoses — and says so on the export.
- **No telehealth video.** An appointment carries a modality flag and a join-link
  field; the *scheduling* consequences of modality are the lesson.
- **One treating clinician per client.** Group sessions exist (one hour, one
  clinician, N attendees, each with their own note and fee), but couples work
  with two clinicians on one record does not.
- **Clients never log in.** Forms, confirmations and their own schedule arrive by
  tokenized link. The portal shows appointment times and nothing clinical, and a
  reschedule request is a reason code rather than a message — there is no
  free-text channel from a client to the front desk.
- **A client can text back, and nothing they write is kept.** An inbound reply is
  classified as `confirm`, `decline`, `opt_out` or `unparsed` in memory and then
  discarded — the `InboundReply` table has no column for a message body, which is
  the guarantee rather than a policy about not reading it. An `unparsed` reply
  alerts the treating clinician alone, sends back the practice's number and the
  urgent-help line, and tells front desk to ring the client, with nothing to read.
- **No real carrier is attached.** Nothing is actually sent: `simulatedCarrier`
  is the only driver, and it decides delivery offline and deterministically.
  What is *not* a stub is the rule around it — the no-show fee's precondition is
  a delivery receipt, not a queued message, so a client the practice could not
  reach is never charged for silence. Attaching a real provider means writing a
  second `Carrier` and changing no policy code.

## Stack

Next.js (App Router) · Prisma · PostgreSQL · Vitest · Playwright · TypeScript

## Running it

```bash
createdb clearpath_dev clearpath_test clearpath_e2e clearpath_shadow
npm install
npm run db:setup     # migrate all three, generate the client, seed dev + e2e
npm run dev          # http://localhost:3700
npm test             # 1,622 unit + integration tests
npm run test:e2e     # 32 Playwright tests against a production build
npm run verify:seed  # the seeded quarter, against its own success metrics
```

Local Postgres only, three databases and each for one job:

| Database | Used by | Contents |
|---|---|---|
| `clearpath_dev` | `npm run dev` | a seeded practice quarter |
| `clearpath_test` | `npm test` | truncated between every test |
| `clearpath_e2e` | `npm run test:e2e` | re-seeded at the start of each sweep |

`clearpath_test` and `clearpath_e2e` are separate on purpose. The unit suite
truncates every table between tests and the e2e sweep needs a seeded practice;
sharing one database means whichever suite ran last decides what the other sees.

There is no login. The dev switcher in the sidebar runs the app as any seeded
person — see **Known limitations**. Authorization is real either way.

### The 60-second demo

1. Act as **Rosa Iyer** (supervisor) → **Co-sign queue** → co-sign one of Priya
   Vance's progress notes.
2. Open that client's record. Everything is there — attendance, screeners, the
   note just signed — and where Priya's process notes would be there is a locked
   panel stating the rule.
3. Act as **Elena Sarkis** (practice manager) → open the same client → break
   glass with a reason → the record opens, flagged. The process notes stay shut.

   ![The practice manager's break-glass gate: a required reason field, and a note that break-glass reaches demographics and progress notes but not process notes — nothing does.](docs/screenshots/break-glass.png)

4. Act as **Owen Delacroix** (auditor) → **Audit log** → both events are there,
   the co-signature and the refusal.

   ![The audit log filtered to denials of process notes, showing one row: a supervisor's read, denied. Ids only — no names, no note content, no answers. The When cell is boxed out in the capture: the audit table stamps `at` from the database clock, so it is the one value that moves between seed runs.](docs/screenshots/audit-log.png)

`e2e/confidentiality.spec.ts` is that walkthrough as a test.

The seed creates obviously-fake clients (`Test Client 001` …) across a scripted
practice quarter: 70 clients on standing weekly or biweekly slots, a clinician's
week of annual leave with the standing sessions it displaces, ~86 form
submissions including flagged screeners, three break-glass events and a logged
process-note refusal.

The quarter is **simulated rather than assigned**. Every day of it gets a
reminder-horizon run, the clients who answer answer through their own tokenized
link, and the non-response sweep runs at midnight — so the 1,176 reminders, the
outbox rows and the audit trail are consequences of the shipped code rather than
fixtures shaped to look like consequences. Client behaviour is dealt from a fixed
cycle (70% confirm, 10% decline, 15% silent but present, 5% silent and absent)
so the totals are hand-tallyable rather than sampled. The carrier runs on the
same hourly tick, failing a deterministic slice of messages — a few bad
addresses, a few provider outages that clear on retry — so the quarter contains
real undelivered reminders rather than a uniformly perfect wire.

The seed then checks itself. Twenty-six success metrics run as queries at the end of
`npm run db:seed`, and it refuses to finish if any fails — no fee for a client on
`reminderPreference: 'none'`, **no fee without a delivered message behind it**,
no more than 5% of eligible sessions charged, and every one of the 102 clients
who attended without ever answering charged the session fee rather than the
no-show fee. That last group is the row the confirmation feature is judged on.

Requiring delivery rather than a queued send cost the policy almost nothing and
made it defensible: **33 fees from 685 eligible sessions (4.82%), against 34 from
692 (4.91%) when a queued row was enough.** Seven sessions were asked about and
never reached, and none of them was charged.

## Design

`DESIGN-BRIEF.md` is the brief the interface was built from — personas, the
confidentiality constraints that drive the visual language, the screen
inventory, and the tokens. `app/theme.css` holds every colour, type and spacing
value in the product under semantic names; swapping in a different design system
means replacing that file's values and nothing else.

## Where the interesting parts live

| | |
|---|---|
| The permission matrix | [`src/auth/permissions.ts`](src/auth/permissions.ts) |
| The single guarded door, and the audit write | [`src/auth/guard.ts`](src/auth/guard.ts) |
| Constraints the ORM cannot express | [`prisma/migrations/*_init/migration.sql`](prisma/migrations) |
| Recurrence, and the occurrence-key fix | [`src/scheduling/recurrence.ts`](src/scheduling/recurrence.ts) |
| Scoring, thresholds and critical items | [`src/forms/scoring.ts`](src/forms/scoring.ts) |
| Two-tier notes and co-signature | [`src/notes/service.ts`](src/notes/service.ts) |
| The discretion deny-list | [`src/messaging/outbox.ts`](src/messaging/outbox.ts) |
| Whether the practice may ask, and when | [`src/scheduling/confirmation.ts`](src/scheduling/confirmation.ts) |
| What silence means, and what it does not | [`src/scheduling/nonresponse.ts`](src/scheduling/nonresponse.ts) |
| A reply classified and thrown away | [`src/messaging/inbound.ts`](src/messaging/inbound.ts) |
| The carrier port, and what "delivered" may mean | [`src/messaging/carrier.ts`](src/messaging/carrier.ts) |
| The seed's own success metrics | [`prisma/metrics.ts`](prisma/metrics.ts) |
| Why any of it is shaped this way | [`WRITEUP.md`](WRITEUP.md) |
