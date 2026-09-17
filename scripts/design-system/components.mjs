import fs from 'fs';
import path from 'path';

// Called from sync.mjs with the dist components directory. Running this file
// directly (`node components.mjs`) writes to ./project/components instead,
// which is only useful for a one-off local check.
const OUT = process.env.DS_COMPONENTS_OUT ?? path.join(process.cwd(), 'project', 'components');
fs.mkdirSync(OUT, { recursive: true });

function preview({ group, height = 140, script }) {
  return `<!-- @dsCard group="${group}" height=${height} -->
<div id="root" style="padding:20px; font-family: ui-sans-serif, system-ui, sans-serif; font-size:13px; color: var(--text);"></div>
<script>
const e = React.createElement;
${script}
</script>
`;
}

function write(name, readme, previewHtml) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), readme.trim() + '\n');
  fs.writeFileSync(path.join(dir, 'preview.html'), previewHtml);
}

// ---- Foundational ----

write('Card', `
A bordered, raised content surface — the basic container everything else sits inside.

Use it to group related fields or facts. It carries its own border, background and shadow token; don't nest a second Card inside it.
`, preview({
  group: 'Foundational', height: 130,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e(Clearpath.Card, null,
    e('h3', { style: { fontWeight: 600, margin: 0 } }, 'Standard fee'),
    e('p', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '24px', margin: '6px 0 0' } }, Clearpath.money(18000))
  )
);`,
}));

write('PageHeader', `
The top-of-page title row: a title, an optional subtitle, and right-aligned actions.

One per page, at the top. The title renders at the \`title\` type step (22px).
`, preview({
  group: 'Foundational', height: 100,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e(Clearpath.PageHeader, {
    title: 'Co-sign queue',
    subtitle: 'Supervisee notes waiting for your signature.',
    actions: e('span', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, '3 waiting')
  })
);`,
}));

write('EmptyState', `
What a work-list shows when there is nothing in it.

An empty work-list is a finished work-list, and should look like one rather than like a failure — dashed border, no icon of alarm.
`, preview({
  group: 'Foundational', height: 140,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e(Clearpath.EmptyState, { title: 'No sessions today' },
    'An empty work-list is a finished work-list, and should look like one rather than like a failure.'
  )
);`,
}));

write('Field', `
A read-only label/value pair, set in a definition list.

\`Field\`'s sibling is \`TextField\`, for writing rather than reading. An empty value renders an em dash rather than blank space.
`, preview({
  group: 'Foundational', height: 90,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('dl', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', maxWidth: '360px' } },
    e(Clearpath.Field, { label: 'Standard fee' }, Clearpath.money(18000)),
    e(Clearpath.Field, { label: 'Late cancel' }, Clearpath.money(9000))
  )
);`,
}));

write('Button', `
Four variants, sharing one shape.

Solid foregrounds read from \`--on-solid\`, not a literal white — in dark mode the danger and private fills are light, and white text on them fails contrast. \`private\` carries the private tier's colour, so the one place a clinician writes something nobody else will read looks like nowhere else in the product. \`danger\` is chargeable-or-irreversible actions only — red is spoken for.
`, preview({
  group: 'Foundational', height: 70,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
    e(Clearpath.Button, { variant: 'solid' }, 'Book session'),
    e(Clearpath.Button, { variant: 'quiet' }, 'Save draft'),
    e(Clearpath.Button, { variant: 'danger' }, 'Cancel session'),
    e(Clearpath.Button, { variant: 'private' }, 'Save private note')
  )
);`,
}));

// ---- Forms & status ----

write('TextField', `
A labelled text input — \`Field\`'s sibling for writing rather than reading.

Three pages each reinvented this independently before it became one component. \`id\` defaults to the field name; override it only where two forms on the same page collect the same field.
`, preview({
  group: 'Forms & status', height: 110,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { display: 'grid', gap: '12px', maxWidth: '280px' } },
    e(Clearpath.TextField, { name: 'first-name', label: 'First name' }),
    e(Clearpath.TextField, { name: 'last-day', label: 'Last day away', type: 'date', required: true })
  )
);`,
}));

write('SelectField', `
A labelled select — the dropdown sibling of TextField, same label and control classes.
`, preview({
  group: 'Forms & status', height: 90,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { maxWidth: '280px' } },
    e(Clearpath.SelectField, {
      name: 'coverage', label: 'Who covers', defaultValue: 'dev',
      options: [{ value: 'dev', label: 'Dev Marchetti' }, { value: 'kai', label: 'Kai Oyelaran' }]
    })
  )
);`,
}));

write('Badge', `
A small pill carrying a tone, an optional glyph, and an optional diagonal hatch.

The hatch (\`hatched\`) marks anything chargeable — a status that will appear on a bill — so money is never signalled by colour alone. Six tones share one shape.
`, preview({
  group: 'Forms & status', height: 70,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
    e(Clearpath.Badge, { tone: 'neutral' }, 'neutral'),
    e(Clearpath.Badge, { tone: 'accent' }, 'accent'),
    e(Clearpath.Badge, { tone: 'success', glyph: '✓' }, 'allowed'),
    e(Clearpath.Badge, { tone: 'warning', glyph: '⊘' }, 'denied'),
    e(Clearpath.Badge, { tone: 'danger', glyph: '✕', hatched: true }, 'No show')
  )
);`,
}));

write('StatusChip', `
A session's lifecycle status, from the state machine's own status set.

No-show and late-cancel both take money — read from \`CHARGEABLE\`, the state machine's own list, never a copy kept here — so both carry the hatch and a \`$\` mark, never a glyph difference alone.
`, preview({
  group: 'Forms & status', height: 70,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
    ...Object.keys(Clearpath.STATUS_META).map((s) => e(Clearpath.StatusChip, { key: s, status: s }))
  )
);`,
}));

// ---- Sensitivity & denial ----

write('TierBanner', `
The three sensitivity tiers, each with a glyph as well as a colour.

Operational (◷), Clinical (◈) and Private (⬤) are the one part of this system that is a rule rather than a preference — nothing carries tier by colour alone, because a colorblind clinician reads this all day.
`, preview({
  group: 'Sensitivity & denial', height: 160,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { display: 'grid', gap: '8px', maxWidth: '480px' } },
    e(Clearpath.TierBanner, { tier: 'operational' }),
    e(Clearpath.TierBanner, { tier: 'clinical' }),
    e(Clearpath.TierBanner, { tier: 'private' })
  )
);`,
}));

write('LockedPanel', `
The most important component in the product: what a supervisor sees where a supervisee's process notes would be.

It shows that the section exists, states the rule in plain language, and offers no override affordance of any kind — no "request access", no "justify", no disabled button implying a door. There is no door. A denial is a designed state, not an error state.
`, preview({
  group: 'Sensitivity & denial', height: 200,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { display: 'grid', gap: '16px', maxWidth: '480px' } },
    e(Clearpath.LockedPanel, null),
    e(Clearpath.LockedPanel, { title: 'Audit log' },
      'The audit log is the auditor\\'s instrument. Your role reaches the clinical records it describes, which is why it does not also get to read who looked at them. This is a rule of the practice, not a permission you are missing.'
    )
  )
);`,
}));

write('BreakGlassDialog', `
What a practice manager meets instead of a record, when they are not the treating clinician.

The friction is deliberate and proportionate: a reason is required, the consequence is stated plainly, and the access is attributed. It is not punitive — somebody reaches for this when a client is in crisis and the clinician is unreachable.
`, preview({
  group: 'Sensitivity & denial', height: 340,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e(Clearpath.BreakGlassDialog, { resource: 'this client record', action: () => {} })
);`,
}));

write('BreakGlassBar', `
The standing reminder that break-glass is open, rendered from the staff layout above every page.

It persists across route changes for the whole duration of the access — the one place it must never be possible to navigate away from.
`, preview({
  group: 'Sensitivity & denial', height: 90,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e(Clearpath.BreakGlassBar, {
    reason: 'client called the practice in distress and their clinician is on leave',
    endAction: () => {}
  })
);`,
}));

// ---- Clinical & calendar ----

write('ScreenerResult', `
A screener submission's right column: score, why it flagged, and the signature — each conditional on that fact existing at all.

A total is a conversation starter, not a diagnosis, and not a trend to chase.
`, preview({
  group: 'Clinical & calendar', height: 360,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { maxWidth: '320px' } },
    e(Clearpath.ScreenerResult, {
      totalScore: 14,
      band: { label: 'Moderate' },
      needsReview: true,
      reviewReasons: ['item_9_above_threshold'],
      signatureName: 'Jordan Ruiz',
      submittedAt: new Date('2026-09-01T09:00:00Z')
    })
  )
);`,
}));

write('CoSignRow', `
One row in the co-signature queue.

Ageing escalates, but not at day two — an unsigned supervisee note is a compliance clock, and a queue that shouts on the first day teaches people to ignore it. \`ageTone\` turns neutral at warning (7 days) then danger (14 days).
`, preview({
  group: 'Clinical & calendar', height: 220,
  script: `
const rows = [
  { id: 's1', waitingDays: 0 },
  { id: 's2', waitingDays: 9 },
  { id: 's3', waitingDays: 16 },
];
ReactDOM.createRoot(document.getElementById('root')).render(
  e('ul', { style: { listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--surface-raised)' } },
    ...rows.map((n) => e(Clearpath.CoSignRow, {
      key: n.id,
      note: {
        id: n.id, waitingDays: n.waitingDays,
        client: { lastName: 'Okafor', firstName: 'Amara', code: 'TC-014' },
        author: { name: 'Priya Vance' },
        appointment: { startAt: new Date('2026-09-01T09:00:00Z') },
        signedAt: new Date('2026-09-01T09:00:00Z'),
      },
      action: () => {},
    }))
  )
);`,
}));

write('AuditRow', `
One row of the audit log. Ids only — names are resolved by the caller and passed in, since the log itself never stores one.

A break-glass or denied row tints the whole row rather than adding a third badge column.
`, preview({
  group: 'Clinical & calendar', height: 130,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' } },
    e('tbody', null,
      e(Clearpath.AuditRow, {
        row: { id: 'a1', at: new Date('2026-09-01T09:00:00Z'), action: 'read', resource: 'progress_note', breakGlass: false, allowed: true, reason: 'leave:abc123' },
        actorLabel: 'Dev Marchetti', roleLabel: 'Supervisor', clientLabel: 'TC-014'
      }),
      e(Clearpath.AuditRow, {
        row: { id: 'a2', at: new Date('2026-09-01T09:00:00Z'), action: 'read', resource: 'process_note', breakGlass: false, allowed: false, reason: null },
        actorLabel: 'Priya Vance', roleLabel: 'Associate', clientLabel: 'TC-021'
      })
    )
  )
);`,
}));

write('AppointmentChip', `
One session in a calendar day column. Not a badge: it says status, modality, series membership and money in about 40px of height.

The left edge carries status colour, thicker while live (arrived/in session). Modality is a shape, not a word (▮ room, ◠ call). A series member carries ↻ (standing) or ↷ (moved off its pattern). A chargeable outcome gets the same hatch and \`$\` mark as StatusChip.
`, preview({
  group: 'Clinical & calendar', height: 300,
  script: `
const sessions = [
  { id: 'd1', status: 'confirmed', modality: 'in_person', seriesId: 's', detached: false, top: 0 },
  { id: 'd2', status: 'in_session', modality: 'telehealth', seriesId: null, detached: false, top: 60 },
  { id: 'd3', status: 'no_show', modality: 'in_person', seriesId: 's', detached: true, top: 120 },
  { id: 'd4', status: 'late_cancelled', modality: 'telehealth', seriesId: 's', detached: false, top: 180 },
];
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { position: 'relative', height: '260px', maxWidth: '260px' } },
    ...sessions.map((d) => e(Clearpath.AppointmentChip, {
      key: d.id, top: d.top, height: 46,
      session: {
        id: d.id, status: d.status, modality: d.modality, seriesId: d.seriesId, detached: d.detached,
        startMinute: 9 * 60, endMinute: 9 * 60 + 50,
        client: { lastName: 'Okafor' }, clinician: { name: 'Maya Lindqvist' },
      },
    }))
  )
);`,
}));

// ---- Mark ----

write('Logo', `
Three rings for the three sensitivity tiers — operational outside, clinical in the middle, private at the centre — and a path that comes in from outside, through the gap, and stops before the core.

Access reaches the record. It does not reach the middle of it. One colour (\`currentColor\`), so it works in a header, on a login card, at favicon size, and in a print export.
`, preview({
  group: 'Mark', height: 100,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '18px', color: 'var(--accent)' } },
    ...[16, 22, 32, 56].map((s) => e(Clearpath.Logo, { key: s, size: s }))
  )
);`,
}));

write('Wordmark', `
The mark plus the product name, and an optional practice line underneath.

Used at the top of the staff shell and on the design system page itself.
`, preview({
  group: 'Mark', height: 80,
  script: `
ReactDOM.createRoot(document.getElementById('root')).render(
  e(Clearpath.Wordmark, { practice: 'Stillwater Counseling' })
);`,
}));

console.log('wrote', fs.readdirSync(OUT).length, 'component folders');
