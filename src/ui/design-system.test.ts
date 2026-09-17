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

it('text tokens clear AA against every surface they sit on', () => {
  const theme = readFileSync('app/theme.css', 'utf8');
  const split = theme.indexOf('@media');
  const value = (css: string, name: string) => {
    const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
    if (!m?.[1]) throw new Error(`${name} not found`);
    return m[1];
  };
  const surfaces = ['--surface', '--surface-raised', '--surface-sunken'];
  // `--text-subtle` is the smallest type in the product, so it is never "large
  // text": 4.5:1 is the bar, not 3:1.
  for (const [label, css] of [
    ['light', theme.slice(0, split)],
    ['dark', theme.slice(split)],
  ] as const) {
    for (const surface of surfaces) {
      const r = ratio(value(css, '--text-subtle'), value(css, surface));
      expect(r, `${label}: --text-subtle on ${surface} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    const tier = ratio(value(css, '--tier-operational'), value(css, '--tier-operational-soft'));
    expect(tier, `${label}: --tier-operational on its soft background is ${tier.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }
});
