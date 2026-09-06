import { prisma } from '../../../src/db';
import { requireSession } from '../../../src/session';
import { guarded } from '../../../src/auth/guard';
import { Badge, Card, Field, PageHeader, money } from '../../../src/ui/primitives';
import { ROLE_LABEL } from '../../../src/ui/shell';
import { withDenial } from '@/src/ui/denied';
import { requiresSecondFactor } from '../../../src/auth/permissions';
import { Button } from '@/src/ui/button';
import { clearSecondFactorAction } from './actions';

export const dynamic = 'force-dynamic';

async function PracticePage() {
  const { actor } = await requireSession();

  const data = await guarded(
    { actor, action: 'read', resource: 'user' },
    async (tx) => ({
      users: await tx.user.findMany({
        where: { role: { not: 'client' } },
        select: {
          id: true, name: true, email: true, role: true, active: true,
          // When they enrolled, and deliberately not the secret itself. This is
          // a status; the credential beside it is on the list `sessions.test.ts`
          // refuses anywhere outside `src/auth/`, and that lint is blunt on
          // purpose — it fails on the *name*, comments included, which is why
          // this one is careful not to write it. A page that can select a
          // credential is one careless `select` from putting it in its own
          // HTML, and this page needs to know nothing beyond whether there is
          // one.
          totpEnrolledAt: true,
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

  return (
    <>
      <PageHeader title="Practice" subtitle="People, supervision, rooms and policy" />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 font-semibold">People</h2>
            <div className="scroll-x">
              <table className="w-full min-w-[520px] border-collapse text-body">
                <thead>
                  <tr className="text-left text-muted">
                    {['Name', 'Role', 'Supervised by', 'Status', 'Second factor'].map((h) => (
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
                      <td className="border-b py-2" style={{ borderColor: 'var(--border)' }}>
                        <SecondFactor id={u.id} role={u.role} enrolled={!!u.totpEnrolledAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                {/* Its own field, because a cancellation with some notice and
                    an empty room are not the same event. Ships at the same
                    figure, so the split changed nothing on the day it landed. */}
                <Field label="No-show fee">{money(data.settings.noShowFeeCents)}</Field>
                <Field label="Booking horizon">{data.settings.recurrenceHorizonDays} days</Field>
                <Field label="Continuity gap">{data.settings.continuityGapDays} days</Field>
                <Field label="Name used in messages">{data.settings.messagingName}</Field>
              </dl>
              <p className="mt-3 text-caption text-subtle">
                Messages to clients use &ldquo;{data.settings.messagingName}&rdquo;, not
                &ldquo;{data.settings.name}&rdquo;. A lock-screen preview should not say why
                somebody is coming in.
              </p>
            </Card>
          )}

          {data.settings && (
            <Card>
              <h2 className="mb-2 font-semibold">Confirmation</h2>
              <dl className="space-y-2.5">
                <Field label="Reminder stages">5 days, 1 day, day-of</Field>
                <Field label="Day-of lead">{data.settings.dayOfLeadHours} hours before the start</Field>
                <Field label="Grace period">{data.settings.graceMinutes} minutes</Field>
                <Field label="Quiet cadence after">
                  {data.settings.confirmationStreakCap > 0
                    ? `${data.settings.confirmationStreakCap} confirmations in a row`
                    : <Badge glyph="○">Off — every client gets all three</Badge>}
                </Field>
                <Field label="Mark no-show automatically">
                  {data.settings.autoNoShowOnNoResponse
                    ? <Badge tone="warning" glyph="●">On</Badge>
                    : <Badge glyph="○">Off — recorded, not charged</Badge>}
                </Field>
              </dl>
              <p className="mt-3 text-caption text-subtle">
                The grace period is both ends of the same number: below that much notice
                there was no time to ask, and that far past the start, silence is an
                answer. Turning the transition off keeps every record of who did not
                reply and stops the charge — the evidence is never the optional part.
              </p>
              <p className="mt-2 text-caption text-subtle">
                A client who confirms that many times running drops to the day-before
                message alone until they miss one. Earning the quieter cadence takes
                several answers; losing it takes one, so a client drifting out of the
                habit has their reminders back before the drift can cost them.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Whether somebody holds a second factor, and the one thing to do about it.
 *
 * Only a clear, never a view and never a set. This is the path for a lost
 * authenticator, and the account drops back to mandatory enrolment so its owner
 * chooses the new secret — an administrator who could *set* one would be an
 * administrator who could sign in as a clinician, and the audit log would
 * faithfully record it as them.
 *
 * It widens `admin`, which was already the most valuable credential in the
 * building, and that concentration is real rather than designed away. What is
 * available instead is that every use is one audit row naming who, naming whom,
 * and never quiet — which is why the copy says so on the button rather than in
 * a comment nobody at the front desk reads.
 */
function SecondFactor({ id, role, enrolled }: { id: string; role: string; enrolled: boolean }) {
  if (!requiresSecondFactor(role as Parameters<typeof requiresSecondFactor>[0])) {
    return <span className="text-caption text-subtle">Not required</span>;
  }
  if (!enrolled) return <Badge tone="warning">Set up on next sign-in</Badge>;

  return (
    <form action={clearSecondFactorAction} className="flex items-center gap-2">
      <input type="hidden" name="userId" value={id} />
      <Badge tone="success">Enrolled</Badge>
      {/*
        `danger` because this is what the variant is for: it cannot be undone,
        it ends their sessions, and it puts a clinical account back to choosing
        a factor. A quiet button here would understate what the click does.
      */}
      <Button type="submit" variant="danger" className="text-caption">
        Clear
      </Button>
    </form>
  );
}

export default withDenial(PracticePage, {
  title: 'Practice settings',
  children:
    'Clinicians, rooms, supervision relationships and the fee schedule are the practice manager’s to change.',
});
