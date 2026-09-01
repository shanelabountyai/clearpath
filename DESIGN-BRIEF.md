# Clearpath — Design Brief

*Feed this whole file to Claude Design. It describes the product, the people who
use it, the constraints that are non-negotiable, and the specific artifacts to
produce. Everything here is real: the app is being built against it.*

---

## 1. What this is

**Clearpath** is internal operations software for **Stillwater Counseling**, a
group psychotherapy practice: 6 clinicians (2 licensed supervisors, 3 licensed
therapists, 1 pre-licensed associate) sharing 4 therapy rooms. It handles the
calendar, client records, intake and screening forms, clinical notes, and an
audit trail.

It is a **desktop-first internal tool used all day**, not a marketing site and
not a consumer app. Two exceptions are public-facing and must feel different:
the client's tokenized form pages and the appointment reminder messages.

Synthetic data only — this is a learning project, never real client records.

## 2. The one idea the design has to carry

**Confidentiality is layered, and the interface must make the layer obvious at a
glance.**

A counseling practice is not a hierarchy where seniority sees more. A supervisor
must co-sign an associate's official *progress note* and must **never** see
anyone's private *process note* — not their supervisee's, not with an override,
not ever. The practice manager can break glass into demographics and progress
notes, and break-glass still does not reach a process note. The front desk runs
the entire calendar while never learning why anyone is in the building.

So the design job is not "make a pretty EHR." It is: **at every moment, the user
should be able to tell what tier of information they are looking at, and a
person looking over their shoulder should learn as little as possible.**

Concretely, the design must give us:

- A **visual language for sensitivity tiers** that is not just a color: it needs
  to survive greyscale, colorblindness, and a glance. Three tiers:
  1. **Operational** — names, times, rooms, consent status, fees. Front desk sees this.
  2. **Clinical** — progress notes, screener scores, session focus. The treating clinician and, for progress notes, their supervisor.
  3. **Private** — process notes. The author alone.
- A **denial state that reads as designed, not broken.** A supervisor who opens
  a supervisee's chart sees the process-note section *acknowledged and closed*,
  not missing and not a 500. It should feel like a locked drawer in a room you
  are allowed to be in. The copy matters: this is a rule, not an error, and the
  user did nothing wrong.
- A **break-glass flow with friction proportional to consequence.** Requires a
  typed reason, states plainly that the access is logged and attributed, and
  leaves a persistent marker on screen for the duration of the session. It
  should feel serious without feeling punitive — someone uses this when a client
  is in crisis.
- **Discretion in every outbound artifact.** Reminder text is literally
  "Appointment reminder: Tue 3:00 PM, Stillwater" — never "counseling," never a
  clinician's specialty, never a session type. Design the preview surface so
  that a leak is visible before it sends.

## 3. Who uses it

| Persona | Where they live in the app | What they need from the design |
|---|---|---|
| **Front desk** | Day/week calendar, check-in, forms, waitlist | Speed and density. Booking a recurring session and checking someone in are the two things they do 50×/day. They are often mid-conversation with a person standing in front of them. Big hit targets, keyboard-first, no modals that lose their place. |
| **Therapist** | Their own day, client charts, notes | Focus. They open this between sessions with ten minutes. Writing a progress note and a process note back to back should feel like two distinct rooms, never like two tabs of the same form. |
| **Associate** (pre-licensed) | Same as therapist | Needs to see co-signature state on their own notes without it feeling like surveillance. "Pending co-signature" is normal, not a failing grade. |
| **Supervisor** | Their own caseload + a co-sign queue | The queue is a compliance clock. Aging matters. They also hit the process-note wall constantly, so that state must never feel like a bug. |
| **Practice manager** | Users, roles, supervision map, rooms, fees, reports | Administrative density. Rarely touches clinical. Break-glass is the exception, not a button they see all day. |
| **Auditor** | One screen: the audit log | A filter-and-read surface. Long tables, scannable, exportable. Flagged events must find the eye immediately. |
| **Client** | A tokenized form link on their phone | Calm, private, unbranded-as-clinical. Mobile-first. Resumable. A screener asking about self-harm is on this surface — the tone has to be right. |

## 4. Emotional register

Get this wrong and the whole thing fails. Aim for:

- **Calm, quiet, unhurried.** No dashboards shouting metrics. No gamification —
  screener scores are especially not a scoreboard, and trend lines over
  someone's depression score need handling with visible restraint.
- **Warm but not cute.** No illustration whimsy, no mascot, no exclamation
  marks. This is a workplace where people discuss suicide risk.
- **Substantial, not clinical-sterile.** Not a hospital EHR's grey. Think a
  well-kept private practice: warm neutrals, real typography, generous
  whitespace, one confident accent.
- **Discretion as an aesthetic.** Information appears when asked for. Nothing
  sensitive renders in a hover preview, a tooltip, a page title, or a
  notification badge that says more than a count.

## 5. What to produce

### 5a. Design tokens (the priority — this is what plugs into the code)

We use Tailwind v4, so tokens land in a single `@theme` block. Please give
**semantic names, not raw values**, in both light and dark:

- **Color**: `surface`, `surface-raised`, `surface-sunken`, `border`,
  `border-strong`, `text`, `text-muted`, `text-subtle`, `accent`,
  `accent-contrast`, plus status colors `success`, `warning`, `danger`, `info`.
- **Sensitivity tiers**: `tier-operational`, `tier-clinical`, `tier-private`,
  each needing a background, a border, and a foreground that all pass WCAG AA
  against their own pair, in both themes.
- **Appointment status**: 8 states that must be distinguishable in a dense
  calendar — `scheduled`, `confirmed`, `arrived`, `in_session`, `completed`,
  `no_show`, `cancelled`, `late_cancelled`. `late_cancelled` and `cancelled`
  must be tellable apart at a glance because one is chargeable. Do not rely on
  hue alone; the calendar needs pattern, weight, or shape too.
- **Type scale**: a UI scale (12/13/14/16/18/24/32) and a separate *reading*
  face for note bodies, which are long-form prose people write and read for
  minutes at a time. Note composition should feel like writing, not like
  filling in a field.
- **Spacing, radius, shadow, motion** (motion: restrained; nothing bounces).

Deliver as a token table **and** as a ready-to-paste CSS `@theme` block.

### 5b. Core components

Specify each with default / hover / focus / active / disabled / error, and with
its dark-mode variant:

1. **Sensitivity banner** — the persistent marker that says which tier the
   current content is. Needs an icon system that works without color.
2. **Locked panel** — the process-note denial. The single most important
   component in the product. Show the section exists, state the rule in plain
   language, offer no override affordance whatsoever.
3. **Break-glass dialog** — reason required, consequences stated, and the
   **break-glass session bar** that persists afterwards.
4. **Appointment chip** (calendar) and **appointment card** (detail) — carrying
   client name, time, room or a telehealth marker, and status. In-person vs
   telehealth must be instantly distinguishable; telehealth has no room.
5. **Recurring-series indicator** — this instance vs. the whole series, and a
   "detached from series" state for an instance that got rescheduled.
6. **Consent-outstanding banner** — high prominence on a client record. Seeing a
   client without signed consent is a liability event, so this is loud.
7. **Note editor** — two visually distinct variants, progress and process. Plus
   states: draft, signed (immutable, amend-only), pending co-signature,
   co-signed. Amendments render as an append-only thread under the frozen
   original.
8. **Co-sign queue row** — with an aging treatment that escalates by days
   waiting without becoming alarming at day two.
9. **Form builder field** and **form renderer field** — short text, long text,
   single/multi select, scale (0–3 Likert, used heavily by screeners), date,
   signature stub. Conditional fields appear and disappear.
10. **Screener result card** — clinician-only. Score, band, and review flags,
    designed so it never implies a diagnosis or a next action.
11. **Alert badge + alert item** — private to the treating clinician. The badge
    shows a count and nothing else, ever.
12. **Audit row** — dense table row with a flagged variant.
13. **Empty, loading, and error states** for lists — and a distinct **"denied"**
    state that is not styled like an error.

### 5c. Screens (wireframe + high-fidelity)

**Staff app** (desktop, ~1440 with a 1280 floor):

1. Day calendar — 4 room columns × time rows, plus a telehealth lane that
   belongs to no room. The hardest layout in the product.
2. Week calendar per clinician.
3. Booking flow — client, type, modality, then availability; when modality is
   telehealth the room requirement disappears. Recurring option: weekly or
   biweekly, with a preview of the generated instances.
4. Client record — front-desk view and clinician view of the *same* record, side
   by side, so the tier difference is legible. This pair is the portfolio shot.
5. Session detail — check-in, status transitions, cancel (with the late-cancel
   window making the consequence explicit *before* confirming).
6. Note composer — progress and process, and the amend flow on a signed note.
7. Supervisor co-sign queue.
8. Vacation reschedule work-list — a clinician takes a week off and every
   affected standing client surfaces as work to redistribute.
9. Continuity queue — clients whose last session completed with nothing booked.
10. Form template builder, including scoring rules and critical-item marking.
11. Auditor log view — filters, flagged-only toggle, CSV export.
12. Admin: users, roles, and the **supervision map** (who supervises whom — a
    small graph, and it drives real access).
13. Dev-mode **user switcher** — there is no real login; this is how the demo
    shows the same screen through six pairs of eyes. Make it look deliberately
    like a dev tool, never like production chrome.

**Client surfaces** (mobile-first):

14. Tokenized form landing → multi-step form → submitted confirmation.
15. Consent form with typed-name signature.
16. Reminder message templates (email + SMS), shown at realistic width, proving
    the discretion rule.

### 5d. The 60-second demo storyboard

The project's whole argument in one take. Please design these five frames as a
sequence:

1. An associate signs a progress note.
2. It lands in their supervisor's co-sign queue.
3. The supervisor co-signs it.
4. The supervisor opens the same client's process note and hits the locked
   panel.
5. The auditor's log shows both events — the co-signature and the denial —
   side by side.

## 6. Hard constraints

- **Accessibility is not a later pass.** WCAG AA contrast minimum, visible focus
  rings on everything, full keyboard operation of the calendar, semantic
  headings, and no meaning carried by color alone (status, tier, and flags all
  need a second channel). Clinicians use this for hours; respect that.
- **Never render clinical content in a place that persists or previews**: page
  titles, browser tabs, hover cards, toasts, notification badges, print
  headers, or URLs. URLs carry opaque ids only.
- **Dark mode is real**, not an afterthought — notes get written at 9pm.
- **Dense but breathable.** The calendar is genuinely information-dense; the note
  editor is genuinely spacious. Both are the same product.
- **No red for "clinical."** Red means danger and chargeable, and it is already
  spoken for by late-cancel and critical-item flags.
- **Nothing about this should look like a startup dashboard.** No gradient hero,
  no glassmorphism, no purple SaaS accent, no big number tiles.

## 7. Vocabulary (use these words exactly)

progress note · process note · co-signature · break-glass · treating clinician ·
supervisee · session (not "appointment" in clinical contexts) · late cancellation ·
screener · critical item · continuity · intake · consent · modality ·
in-person / telehealth · therapy room

Never: patient (they are **clients**), diagnosis, treatment plan, "case."
