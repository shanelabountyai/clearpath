# Next

**Item:** P2-4 (multi-language message bodies) is done, committed and pushed.
**The confirmation PRD is now fully closed — every P0, P1 and P2 is shipped.**
So the next session starts something, rather than continuing something:

1. **A new PRD.** The obvious remaining surfaces are billing/superbill depth,
   the group-session workflow, or an intake pipeline. Architecture-shaped —
   Opus for the PRD itself, then `opusplan` for the build.
2. **`referralSource` at intake** (small, already reasoned through — see below).

## What landed this session

**P2-4 — a second language, and the control that quietly stops working.**
The item on the PRD was "multi-language message bodies," and the parenthesis
next to it was the whole feature: *the deny-list is English-only*. Translate the
templates alone and `Recordatorio: su terapia es el martes` passes
`assertDiscreet` completely — the send succeeds, the row is written, and the one
control standing between a client and a lock-screen disclosure reports success
while doing nothing.

- **A language is a pair, enforced by the type.** `Record<Language, ...>` over
  both `CLIENT_TEMPLATES` and `DENY_LISTS`: a new language does not compile
  until it answers for all six bodies and does not pass its tests until the
  terms answer for it too. There is no arrangement where the templates ship and
  the deny-list is a follow-up ticket.
- **The gate reads every language's list, not the client's own.** Bodies are
  routinely a mix, the language a message is *read* in is not a fact this system
  holds, and checking all of them means adding a language can never weaken the
  gate for the ones already shipping.
- **Both halves were the same three characters.** `'Depresión'.toLowerCase()`
  does not contain `'depresion'`; and inbound's `[^a-z]` strip turned `sí` into
  `s`, which is `unparsed` — an alert to a clinician and a phone call, every
  time a Spanish-speaking client said yes. One exported `fold()` serves both.
- **The inbound phrase table is the union, read language-blind.** A message does
  not arrive with a language on it, and `Client.language` is about what the
  practice *writes*. Safe only while no phrase means opposite things in two
  languages — asserted by a test, not hoped for in a comment. A future collision
  falls to `unparsed`, which is a person ringing the client.
- **988 twice.** The Spanish auto-reply is under the identical constraint
  (`crisis` is spelled the same in both lists) and takes the identical way out:
  digits, never the name of the line.

## The trap this session actually cost time on

**Every `chance()` in `prisma/seed.ts` pulls from one seeded PRNG.** Adding a
`chance(0.12)` for language inside the client-creation loop reshuffled every
decision made after it — and what failed was `confidentiality.spec.ts`, three
files away, on a co-signature count. Seed attributes that are not themselves
random must be *counted*, not drawn: `clientNo % 8 === 3`. Worth remembering the
next time a seed gains a field.

## Gate at this commit

Unit **1603/1603** (was 1589), typecheck clean, e2e **24 passed + 1 skipped**
against the production build. Migration `20260907194526_client_language` applied
to dev, test and e2e — **it is not yet on production**, and neither is
`20260907191212_client_reminder_stages` from the previous session.
`npm run db:migrate:prod` when that matters.

No new e2e spec: `denials.spec.ts` already crawls `/clients/[id]` as every
seeded role, so the language select and its permission gate are exercised. The
rules are unit-tested in `outbox.test.ts` and `inbound.test.ts`.

## Deliberately not done

- **The portal is not translated.** Scope was message bodies. Half a translation
  is worse than none: a Spanish reminder landing on an English fee disclosure is
  the one screen where comprehension is legally load-bearing. That is the
  natural follow-up if Spanish is taken further.
- **No language detection**, on inbound or at intake. Set by a person who asked.
- **No per-message override**, and no machine-translated deny-list.

## Still open, answered but not actioned

The "refer a friend" growth motion is off — anti-kickback, state
patient-brokering, ethics codes, and a referral program cannot be built without
linking two clients' records. The defensible version is a fixed-list
`referralSource` field at intake: attribution only, no credit, no link between
client records.
