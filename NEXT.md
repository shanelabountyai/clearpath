# Next

**Item:** the portal translation is done, committed and pushed. Both PRDs —
the main one and the confirmation one — are fully closed, every P0/P1/P2.

**Read this before trusting the old NEXT.md's suggestions:** it listed group
sessions and superbill depth as remaining surfaces. Both are already shipped
(`src/scheduling/groups.ts`, `/book/group`, WRITEUP §7; `src/billing/superbill.ts`,
WRITEUP §5). Check the PRD checkboxes and WRITEUP headings before picking an item.

## The real remaining gap, and the next item

**An intake / inquiry pipeline.** `WaitlistEntry.clientId` is required, and so is
`FormRequest.clientId` — a person who phones the practice must already be a full
`Client` row, treating clinician assigned and DOB on file, before they can be
waitlisted or sent an intake form. There is no inquiry stage.

Architecture-shaped, so **Opus** for the PRD then `opusplan` for the build. It
absorbs the `referralSource` field that has been sitting in this file, and it
forces the question this codebase has never answered: an inquiry that goes
nowhere must be *deletable*, in a system built end to end on append-only audit
and immutable notes.

The smaller alternative is `referralSource` alone (Sonnet, one session) — but it
is a slice of that PRD, so doing it first means designing the field twice.

## What landed this session

**§17 in WRITEUP.md.** P2-4 translated what the practice *sends*; what it sends
is a link, and the page behind it was English — including the fee disclosure.

- **Three layers, one compiler.** Page copy is code (`src/strings.ts`,
  `Record<Language, Strings>` — a missing key is a build failure). Form question
  text is *data*, so `missingLanguages` gates at **send** time in `issueForm`,
  not render time. Same reasoning as `assertDiscreet`.
- **A copied string typechecks.** `src/strings.test.ts` asserts no key holds the
  same text in both languages; found one true collision (`No`), listed by name.
- **One template version, two languages.** Labels are `Record<Language, string>`
  inside the schema JSON. A submission stores *values*, so `3` reads as "Casi
  todos los días" to the client and "Nearly every day" to staff off the same row
  — score history never forks when a client switches language.
- **Migration `20260908103000_localized_form_labels`** rewrites old template
  versions in place. A reseed would have blanked labels on every historical
  submission. Spanish written empty on purpose → those versions are honestly
  unsendable to a Spanish client.

## Two traps worth carrying forward

- **`src/strings.ts` must stay dependency-light.** `FormRunner` is `'use client'`
  and imports `UI` from it. Anything that transitively pulls in `src/db.ts`
  breaks the client bundle — which is why `Language` lives there and
  `messaging/outbox.ts` re-exports it, rather than the other way round.
- **`openPortal`'s return shape has a test that inventories it**
  (`portal/service.test.ts`, "cannot be used to submit anything clinical").
  Adding a field there is meant to fail; the fix is to justify the field in the
  assertion's comment, not to loosen the assertion.

## Gate at this commit

Unit **1616/1616** (was 1603; +13), typecheck clean, e2e **26 passed + 1 skipped**
against the production build.

Migrations **not yet on production** — three of them now:
`20260907191212_client_reminder_stages`, `20260907194526_client_language`, and
`20260908103000_localized_form_labels`. `npm run db:migrate:prod` when that
matters. The last one is a data migration over `FormTemplate.schema`; it is
idempotent (it only rewrites `jsonb_typeof(...) = 'string'`), but it is the
first migration in this repo that rewrites existing rows rather than adding
structure.

## Deliberately not done

- **Staff pages are not translated.** `STAFF_LANGUAGE` is a constant naming that
  assumption rather than hiding it.
- **No language switcher on the door** — a shared phone's previous reader could
  change it, and the sent message and the opened page would then disagree.
- **No `Intl.DateTimeFormat`.** The weekday is translated; the time stays
  `HH:MM`, matching the practice's own clock everywhere else.
