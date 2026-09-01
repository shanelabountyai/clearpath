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

Every one of those cells is asserted in [`src/auth/permissions.test.ts`](src/auth/permissions.test.ts).
Authorization happens in exactly one place — [`src/auth/permissions.ts`](src/auth/permissions.ts) —
and a test greps the rest of `src/` to prove no endpoint re-implements a role check.

## Known limitations (deliberate)

- **No real auth.** A dev-mode user switcher stands in for login. Two-factor and
  session management are their own project; the seam is marked.
- **No insurance billing.** A session records "completed + fee"; CPT/superbill
  export hangs off that hook later. Sliding-scale fee per client *is* modelled.
- **No telehealth video.** An appointment carries a modality flag and a join-link
  field; the *scheduling* consequences of modality are the lesson.
- **One treating clinician per client.** Couples work (two clinicians, or one
  appointment with several clients) needs group sessions, deferred on purpose so
  v1's data model stays clean.
- **Clients never log in.** Forms and confirmations arrive by tokenized link.
- **All outbound messages are outbox stubs.** Nothing is actually sent.

## Stack

Next.js (App Router) · Prisma · PostgreSQL · Vitest · Playwright · TypeScript

## Running it

```bash
npm install
npm run db:setup     # create + migrate + seed local databases
npm run dev          # http://localhost:3700
npm test             # unit + integration
npm run test:e2e     # Playwright against a production build
```

Local Postgres only — see `CLAUDE.md`. The seed creates obviously-fake clients
(`Test Client 001` …) and a scripted practice quarter.
