/**
 * Builds tokens.json by parsing the app's real token sources — never by
 * hand-transcribing values, which is exactly how a design system drifts.
 *
 *  - Colors, spacing, radius, shadow, and the font stacks: parsed straight
 *    out of app/theme.css's :root block (light) and its dark media block.
 *  - The type scale: parsed out of app/globals.css's `@theme inline` block,
 *    which itself just aliases theme.css's --type-* variables — resolved
 *    back to their literal px values here.
 *
 * Only two things stay hand-maintained, deliberately: the USAGE notes below
 * (prose isn't something to auto-derive) and the COLOR_NAMES / STEPS lists
 * (which tokens belong to which family). Both get a loud warning, never a
 * silent drop, when the source and this file disagree — see the warnings
 * printed at the end of build().
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function extractBlock(source, needle) {
  const start = source.indexOf(needle);
  if (start === -1) throw new Error(`tokens.mjs: could not find "${needle}"`);
  const open = source.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(open + 1, i - 1);
}

function parseVars(block) {
  const out = {};
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = m[2].trim();
  return out;
}

function resolveVarRefs(value, dict) {
  const m = /^var\(--([a-zA-Z0-9-]+)\)$/.exec(value);
  return m ? dict[m[1]] : value;
}

const COLOR_NAMES = [
  'surface', 'surface-raised', 'surface-sunken', 'surface-inset', 'border', 'border-strong',
  'text', 'text-muted', 'text-subtle', 'accent', 'accent-hover', 'accent-contrast', 'accent-soft',
  'success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft', 'info', 'info-soft',
  'tier-operational', 'tier-operational-soft', 'tier-clinical', 'tier-clinical-soft', 'tier-private', 'tier-private-soft',
  'status-scheduled', 'status-confirmed', 'status-arrived', 'status-in-session', 'status-completed',
  'status-no-show', 'status-cancelled', 'status-late-cancelled', 'on-solid',
];

const NON_COLOR_NAMES = [
  'space', 'radius', 'radius-lg', 'shadow-sm', 'motion-state', 'motion-ease', 'reading-leading',
  'font-ui', 'font-reading', 'font-mono',
  'type-nano', 'type-micro', 'type-caption', 'type-body', 'type-lead', 'type-subhead', 'type-title',
];

const USAGE = {
  surface: 'Page background. Warm neutral by design — a well-kept private practice, not a hospital corridor.',
  'surface-raised': 'Cards and other content lifted off the page.',
  'surface-sunken': 'Recessed areas — the locked-panel background.',
  'surface-inset': 'Neutral badge fill.',
  border: 'Default hairline border.',
  'border-strong': 'Emphasized border — dashed denial panels, dialogs.',
  text: 'Primary ink.',
  'text-muted': 'Secondary text.',
  'text-subtle': 'Tertiary text — captions, field labels.',
  accent: 'Primary accent. Same colour as the clinical tier — deliberate: the accent IS the clinical-record colour.',
  'accent-hover': 'Accent hover state.',
  'accent-contrast': 'Text on a solid accent fill.',
  'accent-soft': 'Accent tinted background.',
  success: 'Allowed / confirmed states.',
  'success-soft': 'Success tinted background.',
  warning: 'Awaiting-reply, arrived, ageing warnings.',
  'warning-soft': 'Warning tinted background.',
  danger: 'Chargeable or critical only — red is spoken for, and never means "clinical".',
  'danger-soft': 'Danger tinted background.',
  info: 'Confirmed status, informational badges.',
  'info-soft': 'Info tinted background.',
  'tier-operational': 'Sensitivity tier: names, times, rooms, consent, fees. Front desk sees this.',
  'tier-operational-soft': 'Operational tier banner background.',
  'tier-clinical': 'Sensitivity tier: progress notes, screeners, session focus.',
  'tier-clinical-soft': 'Clinical tier banner background.',
  'tier-private': 'Sensitivity tier: process notes. The author alone — nothing else reaches this, including break-glass.',
  'tier-private-soft': 'Private tier banner background.',
  'status-scheduled': 'Calendar chip: scheduled.',
  'status-confirmed': 'Calendar chip: confirmed.',
  'status-arrived': 'Calendar chip: arrived.',
  'status-in-session': 'Calendar chip: in session.',
  'status-completed': 'Calendar chip: completed.',
  'status-no-show': 'Calendar chip: no-show. Chargeable.',
  'status-cancelled': 'Calendar chip: cancelled.',
  'status-late-cancelled': 'Calendar chip: late-cancelled. Chargeable.',
  'on-solid': 'Text on any solid tier/status/danger/private fill — not a literal white, since those fills are light in dark mode.',
};

const STEPS = [
  ['nano', 'Chart axis labels, the calendar’s hour gutter.'],
  ['micro', 'Uppercase field labels, badges, status chips.'],
  ['caption', 'Secondary metadata under a primary line.'],
  ['body', 'The workhorse: lists, tables, most prose.'],
  ['lead', 'Form controls and anything typed into.'],
  ['subhead', 'Section titles.'],
  ['title', 'One per page, at the top.'],
];

export function build() {
  const warnings = [];

  const themeCss = fs.readFileSync(path.join(ROOT, 'app/theme.css'), 'utf8');
  const light = parseVars(extractBlock(themeCss, ':root {'));
  const darkSection = themeCss.slice(themeCss.indexOf('@media (prefers-color-scheme: dark)'));
  const dark = parseVars(extractBlock(darkSection, ':root:not'));

  for (const name of COLOR_NAMES) {
    if (!(name in light)) warnings.push(`color token "--${name}" is listed here but missing from theme.css — check for a rename`);
  }
  for (const key of Object.keys(light)) {
    if (!COLOR_NAMES.includes(key) && !NON_COLOR_NAMES.includes(key)) {
      warnings.push(`new token "--${key}" found in theme.css — not yet classified in scripts/design-system/tokens.mjs`);
    }
  }

  const colorTokens = COLOR_NAMES.filter((n) => n in light).map((name) => ({
    name,
    value: { light: light[name], dark: dark[name] ?? light[name] },
    usage: USAGE[name] ?? '(needs a usage note in tokens.mjs)',
  }));
  if (colorTokens.some((t) => t.usage.startsWith('(needs'))) {
    warnings.push('one or more color tokens have no usage note — see tokens.mjs USAGE map');
  }

  const globalsCss = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
  const themeInline = parseVars(extractBlock(globalsCss, '@theme inline'));

  const textStyles = STEPS.map(([step, usage]) => {
    const fontSize = resolveVarRefs(themeInline[`text-${step}`], light);
    const lineHeight = Number(themeInline[`text-${step}--line-height`]);
    return { name: step, fontSize, lineHeight, usage };
  });

  const tokens = {
    name: 'Clearpath',
    version: 1,
    color: {
      themes: [{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }],
      tokens: colorTokens,
    },
    type: {
      fonts: [],
      families: {
        sans: light['font-ui'],
        serif: light['font-reading'],
        mono: light['font-mono'],
      },
      groups: [
        { name: 'Text', family: 'sans', styles: textStyles },
        {
          name: 'Reading',
          family: 'serif',
          styles: [{
            name: 'prose',
            fontSize: light['type-subhead'],
            lineHeight: Number(light['reading-leading']),
            usage: 'Clinical note prose — read for minutes at a time, so it gets a real reading face and air, not the interface font at a larger size.',
          }],
        },
      ],
    },
    spacing: {
      tokens: [{
        name: 'space', value: light['space'],
        usage: 'The one base unit. Every padding, gap and sizing utility is a multiple of it, in rem so it scales with the user’s root font size.',
      }],
    },
    radius: {
      tokens: [
        { name: 'radius', value: light['radius'], usage: 'Default — inputs, buttons, chips, tier banners.' },
        { name: 'radius-lg', value: light['radius-lg'], usage: 'Cards, dialogs, locked panels.' },
      ],
    },
    shadow: {
      tokens: [{
        name: 'shadow-sm',
        value: { light: light['shadow-sm'], dark: dark['shadow-sm'] },
        usage: 'The one shadow in the system — Card’s lift off the page.',
      }],
    },
  };

  return { tokens, warnings };
}
