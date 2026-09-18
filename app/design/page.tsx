import { Logo, Wordmark } from '@/src/ui/logo';
import {
  AppointmentChip, AuditRow, Badge, BreakGlassBar, BreakGlassDialog, CONFIRMATION_META,
  Button, Card, CoSignRow, EmptyState, Field, LockedPanel, PageHeader, STATUS_META,
  ScreenerResult, ScrollX, SelectField, StatusChip, TextField, TierBanner, ageTone, money,
  type Tier, type Tone,
} from '@/src/ui/primitives';

/**
 * The design system, rendered from the same components the app renders.
 *
 * A style guide that redraws its specimens by hand starts lying the first week.
 * Every swatch below reads a token and every component below is imported, so
 * this page is wrong only when the app is wrong.
 *
 * It carries no client data and needs no session: it is a spec sheet, not a
 * screen, and it stays outside the staff shell for exactly that reason.
 */
export const metadata = { title: 'Clearpath design system' };

const TYPE_SCALE: [string, string, string][] = [
  ['text-nano', '10.5px', 'Chart axis labels, the calendar’s hour gutter'],
  ['text-micro', '11.5px', 'Uppercase field labels, badges, status chips'],
  ['text-caption', '12.5px', 'Secondary metadata under a primary line'],
  ['text-body', '13px', 'The workhorse: lists, tables, most prose'],
  ['text-lead', '14px', 'Form controls and anything typed into'],
  ['text-subhead', '15px', 'Section titles, and note prose in the serif'],
  ['text-title', '22px', 'One per page, at the top'],
];

const NEUTRALS = ['surface', 'surface-raised', 'surface-sunken', 'surface-inset', 'border', 'border-strong'];
const INK = ['text', 'text-muted', 'text-subtle'];
const TONES = ['accent', 'success', 'warning', 'danger', 'info'];
const TIERS: Tier[] = ['operational', 'clinical', 'private'];

function Swatch({ name, label }: { name: string; label?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="h-9 w-9 shrink-0 rounded-[var(--radius)] border"
        style={{ background: `var(--${name})`, borderColor: 'var(--border-strong)' }}
      />
      <span className="min-w-0">
        <span className="block truncate font-mono text-caption">--{name}</span>
        {label && <span className="block text-nano text-subtle">{label}</span>}
      </span>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-9">
      <h2 className="text-subhead font-semibold tracking-tight">{title}</h2>
      {note && <p className="mt-1 max-w-prose text-body text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The specimens are live components, so their forms need a real action to
 *  point at. This one does nothing: the gallery demonstrates, it does not act. */
async function specimen() {
  'use server';
}

export default function DesignSystemPage() {
  return (
    <main className="mx-auto max-w-[1100px] px-5 py-8">
      <PageHeader
        title="Design system"
        subtitle="Every specimen below is the component the app imports, reading the tokens the app reads."
        actions={<Logo size={32} className="text-accent" />}
      />

      <Section
        title="Mark"
        note="Three rings for the three sensitivity tiers, and a path that comes in from outside and stops before the core. One colour, so it survives a favicon, a header and a print export."
      >
        <div className="flex flex-wrap items-end gap-8">
          {[16, 22, 32, 56].map((s) => (
            <span key={s} className="text-center">
              <Logo size={s} className="text-accent" />
              <span className="mt-1 block font-mono text-nano text-subtle">{s}px</span>
            </span>
          ))}
          <Wordmark practice="Stillwater Counseling" />
        </div>
      </Section>

      <Section title="Type scale" note="Seven steps. The app had grown twelve improvised sizes before this existed.">
        <div className="grid gap-2.5">
          {TYPE_SCALE.map(([cls, px, use]) => (
            <div key={cls} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b pb-2" style={{ borderColor: 'var(--border)' }}>
              <span className={`${cls} w-[320px] shrink-0 font-medium whitespace-nowrap`}>Discreet reminder, Tue 3:00</span>
              <span className="font-mono text-caption text-muted">{cls}</span>
              <span className="font-mono text-nano text-subtle">{px}</span>
              <span className="text-caption text-subtle">{use}</span>
            </div>
          ))}
          <p className="mt-2 max-w-prose font-serif text-subhead leading-reading">
            Note prose sets in the reading face — a serif, because a progress note is
            written and re-read for minutes at a time, not scanned.
          </p>
        </div>
      </Section>

      <Section title="Colour" note="Semantic names only. Red is spoken for: it means chargeable or critical, never “clinical”.">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-2">
            <h3 className="text-micro font-medium tracking-wide text-subtle uppercase">Surfaces</h3>
            {NEUTRALS.map((n) => <Swatch key={n} name={n} />)}
          </div>
          <div className="grid gap-2">
            <h3 className="text-micro font-medium tracking-wide text-subtle uppercase">Ink</h3>
            {INK.map((n) => <Swatch key={n} name={n} />)}
          </div>
          <div className="grid gap-2">
            <h3 className="text-micro font-medium tracking-wide text-subtle uppercase">Tones</h3>
            {TONES.map((n) => <Swatch key={n} name={n} />)}
          </div>
        </div>
      </Section>

      <Section
        title="Sensitivity tiers"
        note="The one part of this system that is a rule rather than a preference. Nothing carries tier by colour alone — each one has a glyph too."
      >
        <div className="grid gap-2.5">
          {TIERS.map((t) => <TierBanner key={t} tier={t} />)}
        </div>
      </Section>

      <Section title="Status" note="Session lifecycle. No-show and late cancel both take money — the state machine's own CHARGEABLE list — so both carry the hatch and the currency mark, never a glyph difference alone.">
        <div className="flex flex-wrap gap-2">
          {Object.keys(STATUS_META).map((s) => <StatusChip key={s} status={s} />)}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as Tone[]).map((t) => (
            <Badge key={t} tone={t}>{t}</Badge>
          ))}
        </div>
      </Section>

      <Section
        title="Confirmation"
        note="Whether the client replied to the reminder is a separate fact from what happened in the room, so it renders as a plain badge beside the status chip rather than as a second chip competing with it. “No reply” is a warning, not a danger: it is the fact the late-cancel fee rests on, and the fee is the status chip’s business."
      >
        <div className="flex flex-wrap gap-2">
          {Object.values(CONFIRMATION_META).map((m) => (
            <Badge key={m.label} tone={m.tone} glyph={m.glyph}>{m.label}</Badge>
          ))}
        </div>
      </Section>

      <Section title="Buttons" note="Solid foregrounds come from --on-solid, which is white in light mode and near-black in dark, where the fills are light.">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="solid">Book session</Button>
          <Button variant="quiet">Save draft</Button>
          <Button variant="danger">Cancel session</Button>
          <Button variant="private">Save private note</Button>
        </div>
      </Section>

      <Section title="Containers">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h3 className="font-semibold">Card</h3>
            <dl className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Standard fee">{money(18000)}</Field>
              <Field label="Late cancel">{money(9000)}</Field>
            </dl>
          </Card>
          <EmptyState title="No sessions today">
            An empty work-list is a finished work-list, and should look like one rather than like a failure.
          </EmptyState>
        </div>
      </Section>

      <Section
        title="Denial"
        note="A refusal is a designed state, not an error state: dashed rather than red, no “request access”, no disabled button implying a door. Same component either way — the record-level denial names the section that exists but is not yours, the list-level one names the whole page."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <LockedPanel />
          <LockedPanel title="Audit log">
            The audit log is the auditor&rsquo;s instrument. Your role reaches the clinical
            records it describes, which is why it does not also get to read who looked at
            them. This is a rule of the practice, not a permission you are missing.
          </LockedPanel>
        </div>
      </Section>

      <Section
        title="Break-glass"
        note="Administration reaches a clinical record only through a logged door. The friction is deliberate and proportionate — a reason is required and the consequence is stated — but it is not an accusation: somebody reaches for this when a client is in crisis and their clinician is unreachable. The bar then renders from the staff layout, above every page, for the whole duration of the access."
      >
        <BreakGlassBar reason="client called the practice in distress and their clinician is on leave" endAction={specimen} />
        <div className="-my-5">
          <BreakGlassDialog resource="this client record" action={specimen} />
        </div>
      </Section>

      <Section
        title="Form fields"
        note="A label, a control, and an id that defaults to the field's name — overridden only where two forms on the same page collect the same field. Three pages reinvented this independently before it was one component."
      >
        <form className="grid gap-3 sm:grid-cols-2">
          <TextField name="specimen-name" label="First name" />
          <TextField name="specimen-date" label="Last day away" type="date" required />
          <SelectField
            name="specimen-select"
            label="Who covers"
            defaultValue="dev"
            options={[{ value: 'dev', label: 'Dev Marchetti' }, { value: 'kai', label: 'Kai Oyelaran' }]}
          />
        </form>
      </Section>

      <Section
        title="Screener result"
        note="A submission's score, why it flagged, and its signature — each conditional on that fact existing. §5b."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ScreenerResult
            totalScore={14}
            band={{ label: 'Moderate' }}
            needsReview
            reviewReasons={['item_9_above_threshold']}
            signatureName="Jordan Ruiz"
            submittedAt={new Date('2026-09-01T09:00:00Z')}
          />
        </div>
      </Section>

      <Section
        title="Co-signature queue"
        note={`Ageing escalates, but not at day two — ${ageTone(0).label}, ${ageTone(9).label} and ${ageTone(16).label} each read differently before a number does.`}
      >
        <Card className="p-0">
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {[
              { id: 's1', waitingDays: 0 },
              { id: 's2', waitingDays: 9 },
              { id: 's3', waitingDays: 16 },
            ].map((n) => (
              <CoSignRow
                key={n.id}
                note={{
                  id: n.id,
                  waitingDays: n.waitingDays,
                  client: { lastName: 'Okafor', firstName: 'Amara', code: 'TC-014' },
                  author: { name: 'Priya Vance' },
                  appointment: { startAt: new Date('2026-09-01T09:00:00Z') },
                  signedAt: new Date('2026-09-01T09:00:00Z'),
                }}
                action={specimen}
              />
            ))}
          </ul>
        </Card>
      </Section>

      <Section
        title="Audit row"
        note="Ids only — names are resolved by the caller and passed in, since the log itself never stores one. A break-glass or denied row tints the whole row rather than adding a third badge column."
      >
        <ScrollX label="Audit row specimen" className="rounded-[var(--radius-lg)] border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full min-w-[700px] border-collapse text-caption">
            <tbody>
              <AuditRow
                row={{ id: 'a1', at: new Date('2026-09-01T09:00:00Z'), action: 'read', resource: 'progress_note', breakGlass: false, allowed: true, reason: 'leave:abc123' }}
                actorLabel="Dev Marchetti" roleLabel="Supervisor" clientLabel="TC-014"
              />
              <AuditRow
                row={{ id: 'a2', at: new Date('2026-09-01T09:00:00Z'), action: 'read', resource: 'process_note', breakGlass: false, allowed: false, reason: null }}
                actorLabel="Priya Vance" roleLabel="Associate" clientLabel="TC-021"
              />
              <AuditRow
                row={{ id: 'a3', at: new Date('2026-09-01T09:00:00Z'), action: 'read', resource: 'client', breakGlass: true, allowed: true, reason: 'break-glass: client in crisis' }}
                actorLabel="Elena Sarkis" roleLabel="Practice manager" clientLabel="TC-009"
              />
            </tbody>
          </table>
        </ScrollX>
      </Section>

      <Section
        title="Appointment chip"
        note="A calendar chip is not a badge: left-edge weight (thicker while live), modality shape (▮ room, ◠ call), series marker (↻ standing, ↷ moved), and the chargeable hatch — with the primary line reading at 13px."
      >
        <div className="relative h-[290px] max-w-xs">
          {[
            { id: 'd1', status: 'confirmed', modality: 'in_person', seriesId: 's', detached: false, top: 0 },
            { id: 'd2', status: 'in_session', modality: 'telehealth', seriesId: null, detached: false, top: 60 },
            { id: 'd3', status: 'no_show', modality: 'in_person', seriesId: 's', detached: true, top: 120 },
            { id: 'd4', status: 'late_cancelled', modality: 'telehealth', seriesId: 's', detached: false, top: 180 },
            { id: 'd5', status: 'cancelled', modality: 'in_person', seriesId: null, detached: false, top: 240 },
          ].map((d) => (
            <AppointmentChip
              key={d.id}
              top={d.top}
              height={46}
              // The gallery fabricates the session shape; the app passes the real one.
              session={{
                id: d.id,
                status: d.status,
                modality: d.modality,
                seriesId: d.seriesId,
                detached: d.detached,
                startMinute: 9 * 60,
                endMinute: 9 * 60 + 50,
                client: { lastName: 'Okafor' },
                clinician: { name: 'Maya Lindqvist' },
              } as never}
            />
          ))}
        </div>
      </Section>
    </main>
  );
}
