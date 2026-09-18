import { readdirSync, readFileSync, statSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * The design system is only a system while nothing bypasses it. Both checks
 * below started as real drift: twelve improvised font sizes between 9.5px and
 * 22px, and four buttons hardcoding white on a fill that is light in dark mode.
 */
function sourceFiles() {
  const out: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (statSync(path).isFile()) out.push(path);
    }
  }
  return out;
}

it('type comes from the scale, not from an arbitrary pixel value', () => {
  const offenders = sourceFiles().filter((p) => /text-\[[0-9.]+px\]/.test(readFileSync(p, 'utf8')));
  expect(offenders).toEqual([]);
});

it('colour comes from a token, never a literal', () => {
  const offenders = sourceFiles().filter((p) =>
    /(?:background|color|border-color|borderColor|fill|stroke)\s*[:=]\s*['"]?#[0-9a-fA-F]{3,8}/.test(
      readFileSync(p, 'utf8'),
    ),
  );
  expect(offenders).toEqual([]);
});

it('the scale a component can ask for is the scale the stylesheet defines', () => {
  const theme = readFileSync('app/theme.css', 'utf8');
  const globals = readFileSync('app/globals.css', 'utf8');
  const steps = ['nano', 'micro', 'caption', 'body', 'lead', 'subhead', 'title'];
  for (const step of steps) {
    expect(theme, `--type-${step} missing from theme.css`).toContain(`--type-${step}:`);
    expect(globals, `text-${step} not exposed as a utility`).toContain(`--text-${step}: var(--type-${step});`);
  }
  // Anything a component uses must be one of those seven.
  const used = new Set<string>();
  for (const p of sourceFiles()) {
    for (const m of readFileSync(p, 'utf8').matchAll(/\btext-([a-z]+)\b/g)) if (m[1]) used.add(m[1]);
  }
  const sizes = [...used].filter((u) => steps.includes(u));
  expect(sizes.sort()).toEqual([...steps].sort());
});

it('every token the light theme defines, the dark theme answers for', () => {
  const theme = readFileSync('app/theme.css', 'utf8');
  const [light, dark] = [theme.slice(0, theme.indexOf('@media')), theme.slice(theme.indexOf('@media'))];
  const names = (css: string) =>
    new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].flatMap((m) => (m[1] ? [m[1]] : [])));
  // Sizes, radii and fonts do not change with the colour scheme; colours do.
  const colourish = [...names(light)].filter((n) => /(surface|border|text$|text-muted|text-subtle|accent|success|warning|danger|info|tier|status|on-solid)/.test(n));
  const inDark = names(dark);
  expect(colourish.filter((n) => !inDark.has(n))).toEqual([]);
});

/**
 * The gallery is the design brief's §5b answer, so a component that exists in
 * the vocabulary but has no specimen has no picture — which is exactly how
 * break-glass, the confirmation badges and the list-level denial went
 * unillustrated while being shipped in the product.
 */
it('every component in the vocabulary has a specimen in the gallery', () => {
  const primitives = readFileSync('src/ui/primitives.tsx', 'utf8');
  const gallery = readFileSync('app/design/page.tsx', 'utf8');
  const exported = [...primitives.matchAll(/^export (?:function|const) ([A-Za-z_]+)/gm)]
    .flatMap((m) => (m[1] ? [m[1]] : []));
  expect(exported.length).toBeGreaterThan(10);
  expect(exported.filter((name) => !new RegExp(`\\b${name}\\b`).test(gallery))).toEqual([]);
});

/**
 * Contrast drifts silently: nothing renders wrong, it just stops being readable.
 * Both pairs below shipped failing AA - `--text-subtle` at 3.52:1 in light mode
 * carried every field label, timestamp and piece of legal small print in the
 * product, including "this link is personal to you" on the client-facing pages.
 */
function ratio(fg: string, bg: string) {
  const lum = (hex: string) =>
    [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i]! * v, 0);
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * PRD 6, Q2: every text token against every surface token, derived from
 * theme.css so a new token is covered the day it lands — not a hand-kept
 * list of the pairs someone remembered to check, which is how both rows in
 * the PRD's failure table shipped.
 *
 * Four groups, each matching how the token is actually used in src/ and app/:
 *  A. --text / --text-muted / --text-subtle (prose) on the four --surface*
 *     tokens. 4.5:1 — none of this is "large text".
 *  B. --border-control and every --status-* token against the same surfaces.
 *     Both are only ever a border or an aria-hidden decorative glyph
 *     (AppointmentChip's status icon, primitives.tsx) — never prose — so
 *     they clear the 3:1 non-text bar (1.4.11), not 4.5:1.
 *  C. Every semantic color that has a `-soft` companion (accent, success,
 *     warning, danger, info, the three tiers), read as text on that
 *     companion. This is the TONE map in primitives.tsx and the tier badge.
 *  D. --on-solid against each of those same semantic colors used as a solid
 *     fill (Button's danger/private variants, the enquiry form's accent
 *     button) — the exact pairing --on-solid's own comment in theme.css
 *     describes.
 *
 * Documented exceptions:
 *  - --text-subtle never sits on --surface-inset in the app (only
 *    --text-muted does, TONE.neutral in primitives.tsx) and the pair is
 *    below 4.5:1. Left undarkened rather than tuned for a pairing nothing
 *    renders.
 *  - --status-scheduled and --status-cancelled are deliberately muted —
 *    "cancelled sessions stay visible but recede" (AppointmentChip,
 *    primitives.tsx) — and both fall under 3:1 on some surfaces. Neither is
 *    ever the only way to read the status: the chip's label text is always
 *    --text, and statusVar only colors a border and an aria-hidden glyph
 *    (WCAG 1.4.11 exempts decorative/inactive graphics from the 3:1 bar).
 */
it('text and UI-boundary tokens clear their contrast bar on every surface they sit on', () => {
  const theme = readFileSync('app/theme.css', 'utf8');
  const split = theme.indexOf('@media');
  const value = (css: string, name: string) => {
    const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
    if (!m?.[1]) throw new Error(`${name} not found`);
    return m[1];
  };
  const names = (css: string, re: RegExp) => [...css.matchAll(re)].flatMap((m) => (m[1] ? [m[1]] : []));
  const NEVER_RENDERS = new Set(['--text-subtle on --surface-inset']);
  const DELIBERATELY_MUTED = new Set(['--status-scheduled', '--status-cancelled']);

  for (const [label, css] of [
    ['light', theme.slice(0, split)],
    ['dark', theme.slice(split)],
  ] as const) {
    const textTokens = names(css, /^\s*(--text(?:-[a-z]+)?):/gm);
    const surfaces = names(css, /^\s*(--surface(?:-[a-z]+)?):/gm);
    const statusTokens = names(css, /^\s*(--status-[a-z-]+):/gm);
    const softTokens = names(css, /^\s*(--[a-z-]+-soft):/gm);
    expect(surfaces, 'surfaces should be derived, not hand-kept').toEqual([
      '--surface', '--surface-raised', '--surface-sunken', '--surface-inset',
    ]);

    // A: prose text on every surface.
    for (const text of textTokens) {
      for (const surface of surfaces) {
        if (NEVER_RENDERS.has(`${text} on ${surface}`)) continue;
        const r = ratio(value(css, text), value(css, surface));
        expect(r, `${label}: ${text} on ${surface} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }

    // B: borders and decorative status glyphs on every surface.
    for (const boundary of ['--border-control', ...statusTokens]) {
      if (DELIBERATELY_MUTED.has(boundary)) continue;
      for (const surface of surfaces) {
        const r = ratio(value(css, boundary), value(css, surface));
        expect(r, `${label}: ${boundary} on ${surface} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    }

    // C + D: a semantic color as text on its own soft fill, and --on-solid
    // as text on that same color used as a solid fill.
    expect(softTokens.length, 'no -soft tokens found — regex drifted from theme.css').toBeGreaterThan(0);
    for (const soft of softTokens) {
      const base = soft.slice(0, -'-soft'.length);
      const r = ratio(value(css, base), value(css, soft));
      expect(r, `${label}: ${base} on ${soft} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      const onSolid = ratio(value(css, '--on-solid'), value(css, base));
      expect(onSolid, `${label}: --on-solid on ${base} is ${onSolid.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

/**
 * A div that scrolls but holds no focusable child cannot be scrolled from the
 * keyboard, and the fix is a `tabindex` plus a name that CSS cannot supply.
 * Eight call sites had the class and none had either, so the class itself is
 * now private to the one component that gets it right.
 */
it('a scrolling box comes from ScrollX, never from the bare class', () => {
  const offenders = sourceFiles().filter(
    (p) => p !== 'src/ui/primitives.tsx' && /scroll-x/.test(readFileSync(p, 'utf8')),
  );
  expect(offenders).toEqual([]);
});

/**
 * An error boundary is the one component whose input is whatever went wrong.
 * A message thrown in a client component reaches the browser verbatim, so a
 * boundary that renders or logs it can put anything on screen (hard rule 3).
 */
it('the staff shell has an error boundary, and no boundary shows the error message', () => {
  const boundaries = sourceFiles().filter((p) => /(^|\/)(global-)?error\.tsx$/.test(p));
  expect(boundaries).toContain('app/(staff)/error.tsx');
  const leaks = boundaries.filter((p) => /error\.message|console\.(error|log)\(\s*error/.test(readFileSync(p, 'utf8')));
  expect(leaks).toEqual([]);
});
