import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { guarded } from '../../../src/auth/guard';
import { Badge, Card, Field, PageHeader, ScrollX, money } from '../../../src/ui/primitives';
import { ROLE_LABEL } from '../../../src/ui/shell';
import { withDenial } from '@/src/ui/denied';
import { previewProcessNotePurge } from '@/src/staff/departure';
import { jobHealth } from '@/src/jobs';
import { systemClock } from '@/src/clock';
import { localDateOf } from '@/src/time';
import { plural } from '../departures/ui';

export const dynamic = 'force-dynamic';

/** `{ queued: 3, promoted: 0 }` as `queued 3, promoted 0`. Counts only ever. */
const countsOf = (counts: unknown) =>
  Object.entries(counts as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(', ');

async function PracticePage() {
  const { actor } = await requireSession();

  const data = await guarded(
    { actor, action: 'read', resource: 'user' },
    async (tx) => ({
      users: await tx.user.findMany({
        where: { role: { not: 'client' } },
        select: {
          id: true, name: true, email: true, role: true, active: true,
          supervisor: { select: { id: true, name: true } },
          supervisees: { select: { id: true, name: true } },
        },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      }),
      rooms: await tx.room.findMany({ orderBy: { name: 'asc' } }),
      settings: await tx.practiceSettings.findUnique({ where: { id: 1 } }),
    }),
  );

  const supervisors = data.users.filter((u) => u.supervisees.length > 0);
  const sweep = await previewProcessNotePurge(actor);
  // After the guard, never before: a denied actor is refused the page above
  // this line, so the card cannot render for somebody the matrix turned away.
  const jobs = await jobHealth(systemClock);

  return (
    <>
      <PageHeader title="Practice" subtitle="People, supervision, rooms and policy" />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 font-semibold">People</h2>
            <ScrollX label="People">
              <table className="w-full min-w-[520px] border-collapse text-body">
                <thead>
                  <tr className="text-left text-muted">
                    {['Name', 'Role', 'Supervised by', 'Status'].map((h) => (
                      <th key={h} className="border-b py-2 font-medium" style={{ borderColor: 'var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td className="border-b py-2" style={{ borderColor: 'var(--border)' }}>
                        <span className="font-medium">{u.name}</span>
                        <span className="block text-caption text-subtle">{u.email}</span>
                      </td>
                      <td className="border-b py-2 text-muted" style={{ borderColor: 'var(--border)' }}>{ROLE_LABEL[u.role]}</td>
                      <td className="border-b py-2" style={{ borderColor: 'var(--border)' }}>
                        {u.supervisor ? u.supervisor.name : <span className="text-subtle">—</span>}
                      </td>
                      <td className="border-b py-2" style={{ borderColor: 'var(--border)' }}>
                        {u.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollX>
          </Card>

          <Card>
            <h2 className="font-semibold">Supervision</h2>
            <p className="mt-1 mb-3 max-w-prose text-body text-muted">
              These relationships are data, not code. Repointing one immediately reroutes
              both read access to progress notes and the co-signature queue — no deploy, no
              cache to clear.
            </p>
            {supervisors.length === 0 ? (
              <p className="text-body text-muted">Nobody is currently supervising.</p>
            ) : (
              <ul className="space-y-3">
                {supervisors.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 text-body">
                    <span className="font-medium">{s.name}</span>
                    <span aria-hidden className="text-subtle">→</span>
                    {s.supervisees.map((sv) => (
                      <Badge key={sv.id} tone="accent">{sv.name}</Badge>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-caption text-subtle">
              A supervisor reads and co-signs their supervisees&rsquo; progress notes. They do not
              read anyone&rsquo;s process notes, supervisees included.
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          {/* Loose thread 19. What runs on a schedule, and whether it did.
              The badge people need to see is the one on a job that has said
              nothing, because every other failure here announces itself and
              that one does not. */}
          <Card>
            <h2 className="mb-2 font-semibold">Scheduled jobs</h2>
            <ul className="space-y-2.5">
              {jobs.map((j) => (
                <li key={j.job}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-body">{j.job}</span>
                    {j.overdue
                      ? <Badge tone="danger" glyph="!">{j.lastAt ? 'Overdue' : 'Never run'}</Badge>
                      : j.ok
                        ? <Badge tone="success">Ran</Badge>
                        : <Badge tone="warning" glyph="!">Failed</Badge>}
                  </div>
                  <p className="text-caption text-subtle">
                    {j.when}
                    {j.lastAt && <> &mdash; last at {j.lastAt.toISOString().replace('T', ' ').slice(0, 19)} UTC</>}
                    {j.error && <> &mdash; <span style={{ color: 'var(--warning)' }}>{j.error}</span></>}
                    {j.ok && j.counts != null && <> &mdash; {countsOf(j.counts)}</>}
                  </p>
                </li>
              ))}
            </ul>
            {/* The sentence that makes the card worth reading. Without it an
                "Overdue" badge looks like a slow job rather than a stopped one. */}
            <p className="mt-3 text-caption text-subtle">
              A job that has gone quiet is the failure worth catching: a cron that stopped
              firing, or a route answering 401 because its secret was never set, is a
              <strong> successful HTTP response</strong> that no uptime check will flag.
              Silence here is the only thing that says so. The stack for a failed run is in
              the platform log &mdash; this table keeps the error&rsquo;s class name and
              nothing else, because an exception message can carry the row that caused it.
            </p>
          </Card>

          <Card>
            <h2 className="mb-2 font-semibold">Rooms</h2>
            <ul className="space-y-1.5 text-body">
              {data.rooms.map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span>{r.name}</span>
                  {r.active ? <Badge tone="success">In use</Badge> : <Badge>Out of use</Badge>}
                </li>
              ))}
            </ul>
          </Card>

          {data.settings && (
            <Card>
              <h2 className="mb-2 font-semibold">Policy</h2>
              <dl className="space-y-2.5">
                <Field label="Standard fee">{money(data.settings.standardFeeCents)}</Field>
                <Field label="Late-cancel window">{data.settings.lateCancelWindowHours} hours</Field>
                <Field label="Late-cancel fee">{money(data.settings.lateCancelFeeCents)}</Field>
                <Field label="No-show fee">{money(data.settings.noShowFeeCents)}</Field>
                <Field label="Non-response grace">{data.settings.graceMinutes} minutes after the start</Field>
                <Field label="Charge for non-response">
                  {data.settings.autoNoShowOnNoResponse
                    ? <Badge tone="warning" glyph="!">On</Badge>
                    : <Badge>Off — recorded, never charged</Badge>}
                </Field>
                <Field label="Reminder cap">
                  {data.settings.confirmationStreakCap > 0
                    ? `day before only, after ${data.settings.confirmationStreakCap} confirmations in a row`
                    : 'off — every client gets all three reminders'}
                </Field>
                <Field label="Booking horizon">{data.settings.recurrenceHorizonDays} days</Field>
                <Field label="Continuity gap">{data.settings.continuityGapDays} days</Field>
                <Field label="Name used in messages">{data.settings.messagingName}</Field>
                <Field label="Enquiry retention">
                  {data.settings.inquiryRetentionDays} days after an enquiry is discarded
                </Field>
                <Field label="Spam retention">
                  {data.settings.spamRetentionDays} days &mdash; never a real caller
                </Field>
                <Field label="Referred-out retention">
                  {data.settings.referredOutRetentionDays} days &mdash; a record the practice acted, not a dead lead
                </Field>
                <Field label="Process notes after a departure">
                  {data.settings.processNoteAfterDepartureDays} days &mdash; then destroyed
                </Field>
                <Field label="Public enquiry form">
                  {data.settings.publicInquiryEnabled
                    ? <Badge tone="success">Open &mdash; /enquire accepts enquiries</Badge>
                    : <Badge>Closed &mdash; the page shows the phone number instead</Badge>}
                </Field>
                <Field label="Public enquiry limit">
                  {data.settings.publicInquiryPerHour} per submitter per hour
                </Field>
              </dl>
              {/* The number is the setting; what it should be is not something
                  this software can tell anybody. */}
              <p className="mt-3 text-caption text-subtle">
                A discarded enquiry is destroyed {data.settings.inquiryRetentionDays} days later
                &mdash; the record goes, the audit trail of what happened to it stays.{' '}
                <strong>How long that number should be is a jurisdictional legal question,
                not an engineering one.</strong> The default here is a placeholder chosen so
                the sweep has something to run against; a real practice sets it from its own
                retention obligations, and this software cannot give it that advice.
              </p>
              {/* The same honesty, about the most sensitive table in the schema.
                  P0-10 asks for this sentence on the page that holds the number. */}
              <p className="mt-3 text-caption text-subtle">
                A process note has one reader, the clinician who wrote it. When that clinician
                leaves it has none, and it is kept {data.settings.processNoteAfterDepartureDays} days
                before it is destroyed &mdash; in some places those notes are the clinician&rsquo;s
                own record if a complaint arrives years later.{' '}
                <strong>How long is a professional and jurisdictional question, not an engineering
                one.</strong> The default is long on purpose: a window that turns out too long can
                be shortened, and one that turns out too short cannot be undone.
              </p>
              {/* P1-5: the window, made visible before it fires. Counts and a
                  date per departure — never which clients the notes were about. */}
              {sweep.length > 0 && (
                <ul aria-label="What the process-note sweep will destroy" className="mt-2 space-y-1 text-caption">
                  {sweep.map((s) => (
                    <li key={s.departureId}>
                      <span className="font-medium">{s.name}</span>: {plural(s.notes, 'process note')},{' '}
                      {s.dueNow > 0
                        ? <strong>{s.dueNow} destroyed on the next run</strong>
                        : <>destroyed from {localDateOf(s.destroyedFrom!)}</>}
                    </li>
                  ))}
                </ul>
              )}
              {/* The kill switch, said out loud on the page that holds it. A
                  practice being flooded should not have to find an engineer. */}
              <p className="mt-3 text-caption text-subtle">
                The public form is the only way into this database that does not
                start with somebody logging in or holding a link.{' '}
                <strong>Closing it takes effect immediately and needs no deploy.</strong>{' '}
                It collects a name and a way to make contact and nothing else &mdash;
                there is deliberately nowhere on it to describe a problem, because
                a box like that on a counselling website receives health details
                from people who have not yet spoken to anybody.
              </p>
              {data.settings.autoNoShowOnNoResponse && (
                /* The honesty note the PRD asks for, on the page where the switch
                   lives. A practice cannot ship an auto-charge policy on the
                   strength of the mechanism working. */
                <p
                  className="mt-3 rounded-[var(--radius)] px-3 py-2 text-caption"
                  style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
                >
                  <strong>This setting charges people automatically.</strong> A session still
                  sitting at scheduled {data.settings.graceMinutes} minutes after it should have
                  started, from a client who never answered, becomes a no-show and takes the fee
                  with no person in the loop. A check-in always beats it, and it never touches a
                  client who was not asked. It is still a policy that needs a clinical and legal
                  review of your client agreement before it is switched on for real people —
                  the software cannot give you that review.
                </p>
              )}
              <p className="mt-3 text-caption text-subtle">
                Messages to clients use &ldquo;{data.settings.messagingName}&rdquo;, not
                &ldquo;{data.settings.name}&rdquo;. A lock-screen preview should not say why
                somebody is coming in.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

export default withDenial(PracticePage, {
  title: 'Practice settings',
  children:
    'Clinicians, rooms, supervision relationships and the fee schedule are the practice manager’s to change.',
});
