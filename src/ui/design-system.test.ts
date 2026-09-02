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
