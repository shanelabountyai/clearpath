# Clearpath

Operations software for a small group counseling practice, built from a single
idea: **confidentiality is layered, and the interface must make the layer
obvious at a glance.**

This system is generated from the real product — every token is copied from
[`app/theme.css`](../app/theme.css), and every component is bundled from
[`src/ui/primitives.tsx`](../src/ui/primitives.tsx) and
[`src/ui/logo.tsx`](../src/ui/logo.tsx). It documents what Clearpath actually
ships, not an idealized version of it.

## The one rule everything else follows

A counseling practice is not a hierarchy where seniority sees more. A
supervisor must co-sign an associate's official *progress note*, and must
**never** see that associate's private *process note* — not with an override,
not ever. A practice manager can break glass into demographics and progress
notes, and break-glass still does not reach a process note.

Three sensitivity tiers carry this everywhere in the interface:

| Tier | Colour | Who sees it |
|---|---|---|
| **Operational** | `tier-operational` | Names, times, rooms, consent, fees. Front desk. |
| **Clinical** | `tier-clinical` | Progress notes, screeners, session focus. Treating clinician, and their supervisor for co-signature. |
| **Private** | `tier-private` | Process notes. The author alone — nothing else reaches it. |

Nothing carries a tier by colour alone — `TierBanner` pairs each colour with
a glyph (◷ ◈ ⬤), because a colorblind clinician reads this all day.

## A denial is a designed state, not an error state

`LockedPanel` is the most important component in the system: what a
supervisor sees where a supervisee's process notes would be. It states the
rule in plain language and offers no override affordance of any kind — no
"request access," no "justify," no disabled button implying a door that
might open. There is no door. Dashed border, never red.

## Break-glass: friction proportional to consequence

`BreakGlassDialog` requires a typed reason before an administrator can open a
clinical record they don't otherwise have access to. `BreakGlassBar` then
renders from the staff layout above every page, for the whole duration of the
access, so it can never be navigated away from. It is not punitive — someone
reaches for this when a client is in crisis and their clinician is
unreachable — but every use is logged and attributed.

## Colour discipline

Red (`danger`) is spoken for: it means *chargeable* or *critical*, never
"clinical." A no-show or late-cancel status carries a diagonal hatch fill
plus a literal `$` glyph, from the state machine's own chargeable list — so
money is never signalled by hue alone.

## What this system is, and isn't

Nineteen components, bundled live from the app's real source (three small,
isolated shims replace Next.js-specific pieces — see `components/bundle.js`'s
header comment for exactly what and why). It does not include the app's
data-fetching, routing, or server actions — every interactive prop
(`action`, `endAction`) is a no-op in these previews, standing in for a real
server call the way the app's own `/design` gallery page does.

Synthetic data only, throughout every preview. This is a learning project;
see the parent repository's README for the full scope note.
