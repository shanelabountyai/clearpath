import Link from 'next/link';
import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { may } from '../../../src/auth/guard';
import { clinicianCapacity, listInquiries, listReferrers, previewInquiryPurge, type InquiryStatus } from '../../../src/clients/inquiry';
import { possibleDuplicates } from '../../../src/clients/repository';
import { Badge, Card, EmptyState, PageHeader, SelectField, TextField, TierBanner } from '../../../src/ui/primitives';
import { withDenial } from '@/src/ui/denied';
import { CONVERT_REFUSAL, Refusal } from '../departures/ui';
import { addReferrer, assign, convert, discard, recordInquiry, setAccepting, toggleReferrer } from './actions';

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
  // "Yours" is the clinician's own queue. It is a filter on a list they can
  // already read in full, not a narrower permission — the matrix says
  // `read: always` and a six-person practice discusses its own intake.
  const mine = q.assigned === 'me';

  const inquiries = await listInquiries(actor, { status, assignedTo: mine ? actor.id : undefined });
  // P1-4: what the next sweep would destroy, so the window is visible before
  // it fires — only worth asking when discarded rows are actually on screen.
  const dueForPurge = status === 'discarded'
    ? new Set((await previewInquiryPurge(actor)).map((r) => r.id))
    : new Set<string>();
  // Declared and measured, side by side (P2). Everyone who works intake reads
  // it; only the clinician it is about may change their own row, and the
  // practice manager deliberately may not change anybody's. It is also the
  // roster the conversion and assignment pickers draw from — one read, because
  // "who can I send this to" and "who has room" are the same question.
  const clinicians = await clinicianCapacity(actor);
  const byId = new Map(clinicians.map((c) => [c.id, c]));
  const names = new Map(clinicians.map((c) => [c.id, c.name]));

  // Who sends the practice people, and who it sends people to (P2). Retired
  // entries come back too and are marked — an enquiry from last March still
  // points at one, and a row that could not name its own referrer would be
  // worse than a row that says "closed".
  const referrers = await listReferrers(actor);
  const referrerLabel = new Map(
    referrers.map((r) => [r.id, r.name ? `${r.name}, ${r.practice}` : r.practice]),
  );
  const openReferrers = referrers.filter((r) => r.active);

  const mayAssign = may({ actor, action: 'update', resource: 'inquiry' });
  // Holding this is what makes somebody a clinician on this page, with no code
  // outside `src/auth/` comparing a role (hard rule 1).
  const mayDeclareCapacity = may({
    actor, action: 'update', resource: 'capacity', target: { subjectUserId: actor.id },
  });
  const own = mayDeclareCapacity ? byId.get(actor.id) : undefined;

  // Both affordances come from the matrix, never from the role. Clinicians
  // take calls and cannot end them; conversion needs `create` on `client`,
  // which only front desk holds — so no new cell had to be reviewed for it.
  const mayDiscard = may({ actor, action: 'discard', resource: 'inquiry' });
  // Front desk and every clinician may add a surgery; only front desk and the
  // practice manager curate the list afterwards. Both come from the matrix.
  const mayAddReferrer = may({ actor, action: 'create', resource: 'referrer' });
  const mayCurateReferrers = may({ actor, action: 'update', resource: 'referrer' });
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
                  borderColor: !mine && status === s ? 'var(--accent)' : 'var(--border)',
                  background: !mine && status === s ? 'var(--accent-soft)' : 'transparent',
                }}
              >
                {s ? s.slice(0, 1).toUpperCase() + s.slice(1) : 'All'}
              </Link>
            ))}
            {mayDeclareCapacity && (
              <Link
                href="/inquiries?assigned=me&status=open"
                className="rounded-[var(--radius)] border px-2.5 py-1"
                style={{
                  borderColor: mine ? 'var(--accent)' : 'var(--border)',
                  background: mine ? 'var(--accent-soft)' : 'transparent',
                }}
              >
                Yours{own?.queued ? ` (${own.queued})` : ''}
              </Link>
            )}
          </nav>
        }
      />

      <div className="mb-4"><TierBanner tier="operational" /></div>

      <Refusal code={q.error} messages={CONVERT_REFUSAL} />

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
              ? `The intake packet was not sent: ${q.sendFailed === 'template_not_translated' ? 'that form has no translation in the client’s language yet.' : 'the form could not be issued.'} Nothing has gone out — send it from the client’s page once the template is fixed.`
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
                <TextField name="code" label="Client code" required />
                <TextField name="dateOfBirth" label="Date of birth" type="date" required />
                <SelectField name="treatingClinicianId" label="Treating clinician"
                  defaultValue={converting.requestedClinicianId ?? ''}
                  options={clinicians.map((c) => ({
                    value: c.id,
                    label: c.accepting ? c.name : `${c.name} — not taking anybody new`,
                  }))} />
                <SelectField name="language" label="Language" defaultValue="en"
                  options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Spanish' }]} />
                <SelectField name="templateKey" label="Intake packet to send" defaultValue=""
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
                    {/* Nobody took this one — it arrived through the public
                        form and has not been spoken to. The badge is the whole
                        feature staff-side: an enquiry with no person behind it
                        is one nobody has rung back yet. */}
                    {i.takenById === null && <Badge tone="info">From the website</Badge>}
                  </div>
                  <p className="mt-1 text-caption text-muted">
                    <span className="font-mono">{i.phone ?? i.email ?? 'no contact given'}</span>
                    {' · '}{REFERRAL_LABEL[i.referralSource] ?? i.referralSource}
                    {i.referrerId && ` (${referrerLabel.get(i.referrerId) ?? 'a practice'})`}
                    {i.referredOutToId && ` · referred to ${referrerLabel.get(i.referredOutToId) ?? 'another practice'}`}
                    {i.requestedClinicianId && ` · asked for ${names.get(i.requestedClinicianId) ?? 'someone'}`}
                    {' · '}{i.createdAt.toISOString().slice(0, 10)}
                  </p>
                  {i.note && <p className="mt-1 max-w-prose text-body text-muted">{i.note}</p>}

                  {i.status === 'open' && (
                    <p className="mt-1 text-caption">
                      {i.assignedClinicianId ? (
                        <>
                          <span className="text-muted">In </span>
                          <span className="font-medium">{names.get(i.assignedClinicianId) ?? 'someone'}</span>
                          <span className="text-muted">&rsquo;s queue</span>
                          {/* The warning front desk needs *after* the fact too:
                              somebody may have closed since the call landed. */}
                          {byId.get(i.assignedClinicianId)?.accepting === false && (
                            <span className="ml-1.5"><Badge tone="warning">not taking anybody new</Badge></span>
                          )}
                        </>
                      ) : (
                        <span className="text-subtle">Nobody&rsquo;s queue yet</span>
                      )}
                    </p>
                  )}

                  {i.status === 'open' && (mayConvert || mayDiscard || mayAssign) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {mayAssign && (
                        <form action={assign} className="flex items-center gap-1.5">
                          <input type="hidden" name="id" value={i.id} />
                          <label htmlFor={`assign-${i.id}`} className="sr-only">Whose queue this call goes in</label>
                          <select
                            id={`assign-${i.id}`} name="clinicianId"
                            defaultValue={i.assignedClinicianId ?? ''}
                            className="rounded-[var(--radius)] border px-2 py-1 text-caption"
                            style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                          >
                            <option value="">Nobody</option>
                            {/* Capacity rides on the option label, so the answer
                                is in front of the person choosing rather than a
                                scroll away. It never removes anybody: a caller
                                who asked for Alex by name still goes to Alex. */}
                            {clinicians.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}{c.accepting ? '' : ' — closed'} · {c.caseload} clients, {c.queued} waiting
                              </option>
                            ))}
                          </select>
                          <button className="rounded-[var(--radius)] border px-2.5 py-1 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                            Assign
                          </button>
                        </form>
                      )}
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
                          {/* Where they went instead. Read only on a
                              `referred_out` discard and ignored on every other
                              reason, so no JavaScript has to hide it — and a
                              reason that is a record of the practice having
                              acted finally says what the act was. */}
                          <label htmlFor={`out-${i.id}`} className="sr-only">Referred to</label>
                          <select
                            id={`out-${i.id}`} name="referredOutToId" defaultValue=""
                            className="rounded-[var(--radius)] border px-2 py-1 text-caption"
                            style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                          >
                            <option value="">Referred to&hellip;</option>
                            {openReferrers.map((r) => (
                              <option key={r.id} value={r.id}>{referrerLabel.get(r.id)}</option>
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

        <div className="space-y-4">
        <Card>
          <h2 className="mb-1 font-semibold">Who has room</h2>
          <p className="mb-3 max-w-prose text-caption text-subtle">
            Two numbers and one answer. The counts are read off the rows — active
            clients, and calls already waiting in that queue — so nobody has to keep
            them true. Whether a clinician is taking somebody new is theirs to say,
            and nobody else&rsquo;s: the practice manager cannot set it either.
          </p>
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {clinicians.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-body">
                <span>
                  {c.name}
                  <span className="ml-1.5 text-caption text-subtle">
                    {c.caseload} clients · {c.queued} waiting
                  </span>
                </span>
                {c.accepting
                  ? <Badge tone="success">open</Badge>
                  : <Badge tone="neutral">closed</Badge>}
              </li>
            ))}
          </ul>

          {own && (
            <form action={setAccepting} className="mt-3 flex items-center gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              {/* No subject field: the action reads it off the session, so there
                  is nothing here to point at another clinician. */}
              <input type="hidden" name="accepting" value={own.declared ? 'no' : 'yes'} />
              <p className="flex-1 text-caption text-muted">
                You are {own.declared ? 'taking new clients' : 'not taking anybody new'}.
              </p>
              <button className="rounded-[var(--radius)] border px-2.5 py-1 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                {own.declared ? 'Close my books' : 'Open my books'}
              </button>
            </form>
          )}
        </Card>

        <Card>
          <h2 className="mb-1 font-semibold">Referring practices</h2>
          <p className="mb-3 max-w-prose text-caption text-subtle">
            Who sends the practice people, and who it sends people to. Entries are
            retired, never deleted &mdash; enquiries point at them, and a surgery that
            closed its list in June is a fact about June, not a reason to rewrite
            March. The public form cannot add to this list.
          </p>
          {referrers.length === 0 ? (
            <p className="text-body text-muted">Nobody in the directory yet.</p>
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {referrers.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-body">
                  <span>
                    {r.practice}
                    {r.name && <span className="ml-1.5 text-caption text-muted">{r.name}</span>}
                    {(r.phone || r.email) && (
                      <span className="ml-1.5 font-mono text-caption text-subtle">{r.phone ?? r.email}</span>
                    )}
                  </span>
                  {mayCurateReferrers ? (
                    <form action={toggleReferrer}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="active" value={r.active ? 'no' : 'yes'} />
                      <button className="rounded-[var(--radius)] border px-2 py-0.5 text-caption" style={{ borderColor: 'var(--border)' }}>
                        {r.active ? 'Retire' : 'Restore'}
                      </button>
                    </form>
                  ) : (
                    !r.active && <Badge tone="neutral">retired</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}

          {mayAddReferrer && (
            <details className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              <summary className="cursor-pointer text-caption text-muted">Add one</summary>
              {/* Front desk hears "Dr Patel at Riverside" mid-call, so adding
                  one lives beside the call form rather than behind a settings
                  page a clinician cannot reach. */}
              <form action={addReferrer} className="mt-3 space-y-3">
                <TextField id="ref-practice" name="practice" label="Practice or agency" required />
                <TextField id="ref-name" name="name" label="Doctor or contact" />
                {/* Labelled apart from the caller's own phone and email on
                    the form below — two boxes on one page called "Phone" is a
                    screen reader reading the same word twice for two
                    different people. */}
                <TextField id="ref-phone" name="phone" label="Practice phone" type="tel" />
                <TextField id="ref-email" name="email" label="Practice email" type="email" />
                <button className="w-full rounded-[var(--radius)] border px-3 py-1.5 text-caption font-medium" style={{ borderColor: 'var(--border-strong)' }}>
                  Add to the directory
                </button>
              </form>
            </details>
          )}
        </Card>

        <Card>
          <h2 className="mb-1 font-semibold">Record a call</h2>
          <p className="mb-3 max-w-prose text-caption text-subtle">
            Nothing is ever sent to an enquiry — no portal link, no form, no text. There
            is nobody to consent yet. That happens at conversion, as its own act.
          </p>
          <form action={recordInquiry} className="space-y-3">
            <TextField name="firstName" label="First name" required />
            <TextField name="lastName" label="Last name" required />
            <TextField name="phone" label="Phone" type="tel" />
            <TextField name="email" label="Email" type="email" />
            <SelectField name="requestedClinicianId" label="Asked for" defaultValue=""
              options={[{ value: '', label: 'Anybody' }, ...clinicians.map((c) => ({ value: c.id, label: c.name }))]} />
            <SelectField name="referralSource" label="How they found us" defaultValue="search"
              options={Object.entries(REFERRAL_LABEL).map(([value, label]) => ({ value, label }))} />
            {/* Only kept when the source above is a GP or clinician — the
                server drops it otherwise and the database refuses the row that
                disagrees, so a change of mind on the select above cannot leave
                a surgery attached to "found us online". */}
            <SelectField name="referrerId" label="Which practice (GP referrals only)" defaultValue=""
              options={[{ value: '', label: 'Not recorded' },
                ...openReferrers.map((r) => ({ value: r.id, label: referrerLabel.get(r.id)! }))]} />
            <TextField name="referralNote" label="Referral detail" />
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
      </div>
    </>
  );
}

export default withDenial(InquiriesPage, {
  title: 'Enquiries',
  children:
    'A call from someone who is not a client yet is still a person asking for care. The people who deliver and administer that care can see it; the auditor reads what happened to it, in the log.',
});
