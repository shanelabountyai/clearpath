import { Logo, Wordmark } from '@/src/ui/logo';
import {
  AppointmentChip, Badge, Button, Card, DeniedState, EmptyState, Field,
  LockedPanel, PageHeader, STATUS_META, StatusChip, TierBanner, money,
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
        <div className="mt-4">
          <LockedPanel />
        </div>
        <div className="mt-4">
          <DeniedState title="Process notes are not listed for your role">
            A denial is a designed state: the list exists, the rule is stated, nothing is red
            and nothing apologises. Distinct from EmptyState&rsquo;s dashed border and empty voice.
          </DeniedState>
        </div>
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
