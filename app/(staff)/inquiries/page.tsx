import Link from 'next/link';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { may } from '../../../src/auth/guard';
import { listInquiries, previewInquiryPurge, type InquiryStatus } from '../../../src/clients/inquiry';
import { possibleDuplicates } from '../../../src/clients/repository';
import { Badge, Card, EmptyState, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { withDenial } from '@/src/ui/denied';
import { convert, discard, recordInquiry } from './actions';

export const dynamic = 'force-dynamic';

const REFERRAL_LABEL: Record<string, string> = {
  gp: 'GP or another clinician',
  friend: 'Friend or family',
  search: 'Found us online',
  other: 'Something else',
};

/** The whole vocabulary, and there is no free-text escape from it (P0-3). */
const DISCARD_LABEL: Record<string, string> = {
  no_answer: 'Called back, no answer',
  not_a_fit: 'Not a fit for this practice',
  referred_out: 'Referred out',
  no_capacity: 'No capacity',
  chose_elsewhere: 'Went elsewhere',
  duplicate: 'Duplicate of another call',
  spam: 'Not a real enquiry',
};

const STATUS_TONE = { open: 'accent', converted: 'success', discarded: 'neutral' } as const;

async function InquiriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { actor } = await requireSession();
  const q = await searchParams;
  const status = (q.status as InquiryStatus | undefined) || undefined;

  const inquiries = await listInquiries(actor, { status });
  // P1-4: what the next sweep would destroy, so the window is visible before
  // it fires — only worth asking when discarded rows are actually on screen.
  const dueForPurge = status === 'discarded'
    ? new Set((await previewInquiryPurge(actor)).map((r) => r.id))
    : new Set<string>();
  const clinicians = await prisma.user.findMany({
    where: { active: true, role: { in: ['therapist', 'associate', 'supervisor'] } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const names = new Map(clinicians.map((c) => [c.id, c.name]));

  // Both affordances come from the matrix, never from the role. Clinicians
  // take calls and cannot end them; conversion needs `create` on `client`,
  // which only front desk holds — so no new cell had to be reviewed for it.
  const mayDiscard = may({ actor, action: 'discard', resource: 'inquiry' });
  const mayConvert = may({ actor, action: 'create', resource: 'client' });

  // The call just recorded, and whether we may already have this person as a
  // client (P1-2). The check is scoped by the same rule as the caseload list,
  // so a clinician matches inside their own caseload and the practice manager
  // matches nothing — see `possibleDuplicates`. An empty result is not a
  // statement that this is a new person, so nothing is drawn for it.
  const recorded = q.recorded ? inquiries.find((i) => i.id === q.recorded) : undefined;
  const duplicates = recorded ? await possibleDuplicates(actor, recorded) : [];

  const converting = mayConvert && q.convert
    ? inquiries.find((i) => i.id === q.convert && i.status === 'open')
    : undefined;

  const templates = converting
    ? await prisma.formTemplate.findMany({
        distinct: ['key'], orderBy: [{ key: 'asc' }, { version: 'desc' }],
        select: { key: true, name: true },
      })
    : [];

  return (
    <>
      <PageHeader
        title="Enquiries"
        subtitle="People who have rung, before there is a client record to put them in"
        actions={
          <nav className="flex gap-1.5 text-body">
            {([undefined, 'open', 'converted', 'discarded'] as const).map((s) => (
              <Link
                key={s ?? 'all'}
                href={s ? `/inquiries?status=${s}` : '/inquiries'}
                className="rounded-[var(--radius)] border px-2.5 py-1"
                style={{
                  borderColor: status === s ? 'var(--accent)' : 'var(--border)',
                  background: status === s ? 'var(--accent-soft)' : 'transparent',
                }}
              >
                {s ? s.slice(0, 1).toUpperCase() + s.slice(1) : 'All'}
              </Link>
            ))}
          </nav>
        }
      />

      <div className="mb-4"><TierBanner tier="operational" /></div>

      {q.error && (
        <p className="mb-4 rounded-[var(--radius)] border px-3 py-2 text-body" style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}>
          {q.error}
        </p>
      )}

      {duplicates.length > 0 && (
        <div className="mb-4 rounded-[var(--radius-lg)] border px-4 py-3" style={{ borderColor: 'var(--warning)', background: 'var(--warning-soft)' }}>
          <p className="font-semibold">We may already know this person</p>
          {/* Codes only, and no name, no clinician, no status: enough to go and
              look, and nothing about whoever is behind the code. */}
          <p className="mt-1 max-w-prose text-body">
            That phone number or email is already on{' '}
            {duplicates.map((d, n) => (
              <span key={d.id}>
                {n > 0 && ', '}
                <Link className="font-mono underline" href={`/clients/${d.id}`}>{d.code}</Link>
              </span>
            ))}
            . The call is recorded either way — check, and if it is the same person,
            discard this one as a duplicate.
          </p>
        </div>
      )}

      {q.converted && (
        <div className="mb-4 rounded-[var(--radius-lg)] border px-4 py-3" style={{ borderColor: q.sendFailed ? 'var(--warning)' : 'var(--success)', background: q.sendFailed ? 'var(--warning-soft)' : 'var(--success-soft)' }}>
          <p className="font-semibold">
            Client record created. <Link className="underline" href={`/clients/${q.converted}`}>Open it</Link>
          </p>
          {/* The send is its own act with its own outcome, and a refusal says
              what is still owed rather than disappearing into the conversion. */}
          <p className="mt-1 text-body">
            {q.sendFailed
              ? `The intake packet was not sent: ${q.sendFailed} Nothing has gone out — send it from the client’s page once the template is fixed.`
              : q.sent
                ? `Intake packet sent (${q.sent}).`
                : 'No intake packet was sent — send one from the client’s page when you are ready.'}
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          {converting && (
            <Card>
              <h2 className="font-semibold">
                Convert {converting.firstName} {converting.lastName} to a client
              </h2>
              <p className="mt-1 mb-3 max-w-prose text-body text-muted">
                What a first phone call cannot capture: a date of birth, a treating
                clinician, and a code to file them under. Everything they already told
                us is carried across — and the enquiry itself is kept, which is what lets
                the practice report say how long a call takes to become a client.
              </p>
              <form action={convert} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={converting.id} />
                <Text name="code" label="Client code" required />
                <Text name="dateOfBirth" label="Date of birth" type="date" required />
                <Pick name="treatingClinicianId" label="Treating clinician"
                  defaultValue={converting.requestedClinicianId ?? ''}
                  options={clinicians.map((c) => ({ value: c.id, label: c.name }))} />
                <Pick name="language" label="Language" defaultValue="en"
                  options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Spanish' }]} />
                <Pick name="templateKey" label="Intake packet to send" defaultValue=""
                  options={[{ value: '', label: 'Do not send anything yet' },
                    ...templates.map((t) => ({ value: t.key, label: t.name }))]} />
                <div className="flex items-end gap-2">
                  <button className="rounded-[var(--radius)] px-4 py-2 text-body font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
                    Convert
                  </button>
                  <Link href="/inquiries" className="px-2 py-2 text-body text-muted underline">Cancel</Link>
                </div>
              </form>
            </Card>
          )}

          {inquiries.length === 0 ? (
            <EmptyState title="No enquiries">
              {status ? 'Nothing with that status.' : 'Nobody has rung yet.'}
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {inquiries.map((i) => (
                <li key={i.id} className="rounded-[var(--radius-lg)] border p-3" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{i.lastName}, {i.firstName}</span>
                    <Badge tone={STATUS_TONE[i.status as InquiryStatus]}>{i.status}</Badge>
                    {i.status === 'discarded' && i.discardReason && (
                      <Badge>{DISCARD_LABEL[i.discardReason] ?? i.discardReason}</Badge>
                    )}
                    {dueForPurge.has(i.id) && <Badge tone="warning">Due in next purge</Badge>}
                  </div>
                  <p className="mt-1 text-caption text-muted">
                    <span className="font-mono">{i.phone ?? i.email ?? 'no contact given'}</span>
                    {' · '}{REFERRAL_LABEL[i.referralSource] ?? i.referralSource}
                    {i.requestedClinicianId && ` · asked for ${names.get(i.requestedClinicianId) ?? 'someone'}`}
                    {' · '}{i.createdAt.toISOString().slice(0, 10)}
                  </p>
                  {i.note && <p className="mt-1 max-w-prose text-body text-muted">{i.note}</p>}

                  {i.status === 'open' && (mayConvert || mayDiscard) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {mayConvert && (
                        <Link
                          href={`/inquiries?convert=${i.id}`}
                          className="rounded-[var(--radius)] border px-2.5 py-1 text-caption font-medium"
                          style={{ borderColor: 'var(--border-strong)' }}
                        >
                          Convert to client
                        </Link>
                      )}
                      {mayDiscard && (
                        <form action={discard} className="flex items-center gap-1.5">
                          <input type="hidden" name="id" value={i.id} />
                          <label htmlFor={`reason-${i.id}`} className="sr-only">Why this enquiry ended</label>
                          <select
                            id={`reason-${i.id}`} name="reason" defaultValue="no_answer"
                            className="rounded-[var(--radius)] border px-2 py-1 text-caption"
                            style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                          >
                            {Object.entries(DISCARD_LABEL).map(([v, l]) => (
                              <option key={v} value={v}>{l}</option>
                            ))}
                          </select>
                          <button className="rounded-[var(--radius)] border px-2.5 py-1 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                            Discard
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <Card>
          <h2 className="mb-1 font-semibold">Record a call</h2>
          <p className="mb-3 max-w-prose text-caption text-subtle">
            Nothing is ever sent to an enquiry — no portal link, no form, no text. There
            is nobody to consent yet. That happens at conversion, as its own act.
          </p>
          <form action={recordInquiry} className="space-y-3">
            <Text name="firstName" label="First name" required />
            <Text name="lastName" label="Last name" required />
            <Text name="phone" label="Phone" type="tel" />
            <Text name="email" label="Email" type="email" />
            <Pick name="requestedClinicianId" label="Asked for" defaultValue=""
              options={[{ value: '', label: 'Anybody' }, ...clinicians.map((c) => ({ value: c.id, label: c.name }))]} />
            <Pick name="referralSource" label="How they found us" defaultValue="search"
              options={Object.entries(REFERRAL_LABEL).map(([value, label]) => ({ value, label }))} />
            <Text name="referralNote" label="Referral detail" />
            <div>
              <label htmlFor="note" className="block text-micro font-medium tracking-wide text-subtle uppercase">
                Scheduling preferences
              </label>
              <textarea
                id="note" name="note" rows={2}
                placeholder="Mornings only, cannot do Tuesdays"
                className="mt-1 w-full rounded-[var(--radius)] border px-2 py-1.5 text-body"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              />
              <p className="mt-1 text-caption text-subtle">
                When they can come in — not why they are calling. This field is read by
                everyone at the front desk.
              </p>
            </div>
            <button className="w-full rounded-[var(--radius)] px-3 py-2 text-body font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
              Record the call
            </button>
          </form>
        </Card>
      </div>
    </>
  );
}

function Text({ name, label, type = 'text', required = false }: {
  name: string; label: string; type?: string; required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-micro font-medium tracking-wide text-subtle uppercase">{label}</label>
      <input
        id={name} name={name} type={type} required={required}
        className="mt-1 w-full rounded-[var(--radius)] border px-2 py-1.5 text-body"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      />
    </div>
  );
}

function Pick({ name, label, defaultValue, options }: {
  name: string; label: string; defaultValue: string;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-micro font-medium tracking-wide text-subtle uppercase">{label}</label>
      <select
        id={name} name={name} defaultValue={defaultValue}
        className="mt-1 w-full rounded-[var(--radius)] border px-2 py-1.5 text-body"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export default withDenial(InquiriesPage, {
  title: 'Enquiries',
  children:
    'A call from someone who is not a client yet is still a person asking for care. The people who deliver and administer that care can see it; the auditor reads what happened to it, in the log.',
});
