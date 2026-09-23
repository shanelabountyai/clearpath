# Clearpath — demo script

A ~10-minute walkthrough. Every step below was run against the live deployment
and a local `npm run dev` on 2026-09-21 and produced the output quoted here —
if a step doesn't match, something changed; don't wing it, check `WRITEUP.md`
and `NEXT.md` for what's outstanding.

## Before you start

**Zero-setup path (recommended):** open **https://clinic.labintelligence.co**.
It's the same seed data as local — no login, no build, no waiting.

**Local path**, if you want to show code alongside the app:

```
npm run dev              # http://localhost:3700, port 3700 is this project's fixed port
```

Requires local Postgres already migrated and seeded (`npm run db:setup` on a
fresh checkout — not re-verified today since this laptop's `clearpath_dev` was
already migrated and seeded; `npm run db:migrate:status` confirms before you
start).

**Accounts:** there is no login. The sidebar has a **"dev: acting as"**
dropdown — that stub *is* the point (see concession #1 below). Pick a name to
become that person. All seeded people:

| Name | Role |
|---|---|
| Marion Whitlock | Front desk |
| Kai Oyelaran, Nour Abadi, Tom Bergqvist | Therapist |
| Priya Vance | Associate (supervised by Rosa Iyer) |
| Rosa Iyer, Dev Marchetti | Supervisor |
| Elena Sarkis | Practice manager (admin) |
| Owen Delacroix | Auditor |

**Sample data:** 70 synthetic clients (`TC-001`…`TC-070`), a full quarter of
recurring sessions, screener submissions, and 1,400+ audit rows already
seeded. The one client this script keeps coming back to is **TC-036 —
"Client 036 Bellweather"**, treated by Priya Vance and supervised by Rosa
Iyer — her record carries a signed progress note, a pending co-signature, and
a process note, which is what makes her useful for every frame below.

---

## The walkthrough

### 1. Front desk sees operations, not clinical content
Sidebar → **Marion Whitlock — Front desk**. Open **Calendar**.

*Say:* "Five columns, named sessions, times and rooms. Nothing here says
*why* anyone is on the calendar — not even at the level of 'therapy' vs.
'intake.' Front desk needs to know a room is occupied, never what for."

Screenshot on file: `docs/screenshots/calendar-front-desk.png`.

### 2. An associate's note goes into the record
Switch to **Priya Vance — Associate**. Open **Clients → search "TC-036"** →
her record. Point at **Progress notes**: one session is `✓ Co-signed`, one is
still `✍ Pending co-signature`. Below that, **My process notes** — her own
private working notes, visible only to her.

*Say:* "Two kinds of note. The progress note is the official record and her
supervisor has to countersign it. The process note is hers alone — not even
her supervisor gets it."

### 3. The supervisor co-signs — and is refused the other note
Switch to **Rosa Iyer — Supervisor**. Open **Co-sign queue** — 6 notes
waiting, including TC-036's. Click **Co-sign** on it, read the confirmation
dialog ("cannot be withdrawn"), confirm.

Now open the **same TC-036 record** as Rosa. Progress notes: the one you
just signed now shows co-signed. Scroll to **Process notes by Priya Vance** —
the section explains the rule instead of showing content:

> "Process notes are the clinician's own working record and are visible only
> to the person who wrote them. That includes you as their supervisor, the
> practice manager, and break-glass access."

*Say:* "She's the supervisor of the author, and she still gets nothing but
that sentence. Not a 403 page — a page that tells her *why*, in the record
itself."

Screenshots on file: `docs/screenshots/cosign-queue.png`,
`docs/screenshots/process-notes-locked.png`.

### 4. Break-glass, logged
Switch to **Elena Sarkis — Practice manager**. Open TC-036 and try to read
the process note — refused, same as Rosa, no exceptions (hard rule 2). Open
any *progress* note instead and use **break-glass** with a reason. The bar at
the top of the screen stays visible for the whole session as a reminder
she's using it.

Screenshot on file: `docs/screenshots/break-glass.png`.

### 5. The auditor sees both sides
Switch to **Owen Delacroix — Auditor**. Open **Audit log**, filter **Client →
TC-036**. Point out: Priya's original write, Rosa's co-sign, Rosa's *denied*
read of the process note, Elena's break-glass read — all there, all with a
rule name, none with note content.

*Say:* "The denial is logged the same as the grant. And the reason column —
it's a code, `leave:<id>` or `probe`, never free text, because free text is
how PHI leaks into a log."

Screenshot on file: `docs/screenshots/audit-log-both.png`.

### 6. The client side — what a leaked link discloses
Open **Enquire** (`/enquire`, no login needed — it's the public intake
form). Fill and submit; note the fee disclosure / consent language and, if
demoing in Spanish, `docs/screenshots/fee-disclosure-es.png`.

If you have a portal link handy from a client record (**Send their
appointments link**), open it: only that client's own schedule. No notes, no
forms, no fees, no other client.

*Say:* "This is the door sized to what a leaked link would disclose — their
own future appointments, nothing else, because a portal link travels by SMS
and SMS gets forwarded."

---

## What to concede before you're asked

- **No real authentication.** The "dev: acting as" switcher is the seam
  where auth would attach — deliberately not built, because getting
  authorization right (who can see what) was the actual lesson, and a real
  login system would have been scaffolding around it. See WRITEUP §9.
- **Nothing sends, nothing is received, nothing charges.** Reminders,
  delivery receipts, and inbound replies are all simulated by scripts
  (`delivery:run`, `inbound:simulate`) standing in for a carrier that was
  never integrated. `chargeFeeCents` is a flag in integer cents with no
  payment processor behind it.
- **Synthetic data only, not HIPAA-compliant software.** It applies
  HIPAA-*inspired* engineering discipline (least privilege, audit trails, no
  PHI in logs/URLs) because that discipline is the point — it does not claim
  the compliance, and it must never hold real client data.
- **Accessibility conformance (PRD 6) is Q1–Q4 of 5 done.** Contrast, axe-core
  CI, and focus/error states are built and green; the one remaining item is
  a manual VoiceOver pass on three forms (Q5) — skipped by decision (see WRITEUP).
- **One known gap**, from `NEXT.md`: the no-JavaScript enquiry refusal e2e
  spec fails (it fails on the commit before too; cause not yet diagnosed).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm run dev` won't bind :3700 | Another process already listening | `lsof -ti :3700`, confirm it's not another project's server before killing it |
| Pages 500 on first load | Prisma client stale after a schema change | `npm run db:generate` |
| Local data looks unfamiliar / empty | DB migrated but not seeded, or reseeded since last demo | `npm run db:migrate:status`, then `npm run db:seed` if `Client` count is 0 |
| Switcher dropdown is empty | Seed never ran, or ran against the wrong `DATABASE_URL` | Check `.env.local` points at `clearpath_dev`, then reseed |
| Live site looks stale after a schema-changing push | Prod migrations are manual, not run by the Vercel build | `npm run db:migrate:prod` before demoing anything that touched the schema |
