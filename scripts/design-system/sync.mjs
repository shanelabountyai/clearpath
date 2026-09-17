#!/usr/bin/env node
/**
 * Rebuilds the Clearpath Design System artifact's files from the current
 * codebase: tokens from app/theme.css + app/globals.css, and the component
 * bundle from this folder's entry.tsx (a shimmed copy of src/ui/primitives.tsx
 * and src/ui/logo.tsx — see entry.tsx's header for exactly what's shimmed
 * and why: Next's <Link>, and two small server-only imports inlined).
 *
 * Run it, review scripts/design-system/dist/, then ask Claude to publish
 * dist/ to the design system's Artifact URL — this script only writes local
 * files, it never talks to claude.ai itself.
 *
 * Usage: node scripts/design-system/sync.mjs
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { build as buildTokens } from './tokens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(HERE, 'dist');
const PROJECT = path.join(DIST, 'project');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(PROJECT, 'components'), { recursive: true });

console.log('1/5  tokens.json — parsing app/theme.css + app/globals.css');
const { tokens, warnings } = buildTokens();
fs.writeFileSync(path.join(PROJECT, 'tokens.json'), JSON.stringify(tokens, null, 2) + '\n');
if (warnings.length) {
  console.log('     ⚠ ' + warnings.join('\n     ⚠ '));
}

console.log('2/5  components/bundle.js — esbuild against entry.tsx');
execFileSync(
  path.join(ROOT, 'node_modules/.bin/esbuild'),
  [
    path.join(HERE, 'entry.tsx'),
    '--bundle', '--format=iife', '--global-name=Clearpath',
    '--jsx=transform', '--jsx-factory=React.createElement', '--jsx-fragment=React.Fragment',
    '--minify', '--loader:.tsx=tsx',
    `--outfile=${path.join(PROJECT, 'components/bundle.js')}`,
  ],
  { stdio: 'inherit' },
);

console.log('3/5  components/bundle.css — the app\'s real Tailwind pipeline, scanning entry.tsx');
const globalsCss = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
const cssResult = await postcss([
  tailwind({ base: ROOT, optimize: false }),
]).process(globalsCss, { from: path.join(ROOT, 'app/globals.css'), to: path.join(PROJECT, 'components/bundle.css') });
fs.writeFileSync(path.join(PROJECT, 'components/bundle.css'), cssResult.css);

console.log('4/5  components/<Name>/{README.md,preview.html} — 19 fixtures from components.mjs');
process.env.DS_COMPONENTS_OUT = path.join(PROJECT, 'components');
await import('./components.mjs?t=' + Date.now());

console.log('5/5  README.md + Cover — copied from this folder\'s maintained copies');
fs.copyFileSync(path.join(HERE, 'readme.md'), path.join(PROJECT, 'README.md'));
fs.mkdirSync(path.join(PROJECT, 'components/Cover'), { recursive: true });
fs.copyFileSync(path.join(HERE, 'cover.preview.html'), path.join(PROJECT, 'components/Cover/preview.html'));

console.log(`\nDone. Review ${path.relative(ROOT, PROJECT)}/, then ask Claude to publish it.`);
