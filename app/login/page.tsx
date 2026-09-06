import Link from 'next/link';
import { redirect } from 'next/navigation';
import { sessionStage } from '../../src/session';
import { ROLE_LABEL } from '../../src/ui/shell';
import { Wordmark } from '@/src/ui/logo';
import { requiresSecondFactor } from '../../src/auth/permissions';
import { DEMO_PASSWORD, demoAccounts } from '../../src/auth/demo';
import { enrolmentSecret } from './actions';
import { ChallengeForm, EnrolmentForm, PasswordForm } from './forms';

export const dynamic = 'force-dynamic';

/**
 * One route for the whole sign-in, rendering whichever step the session is
 * actually on. Routing the stages from one place is what let ~50 pages keep a
 * one-line `requireSession()` — nothing downstream knows a second factor
 * exists, because nothing downstream can be reached until it is satisfied.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; claimed?: string }>;
}) {
  const stage = await sessionStage();
  if (stage?.stage === 'ready') redirect('/');
  const { reset, claimed } = await searchParams;

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <Wordmark practice="Stillwater Counseling — practice operations" />

      <div
        className="mt-6 rounded-[var(--radius-lg)] border p-4"
        style={{ borderColor: 'var(--warning)', background: 'var(--warning-soft)' }}
      >
        <p className="text-body">
          <strong>Learning project, synthetic data only.</strong> Clearpath applies
          HIPAA-inspired design principles. It is not HIPAA-compliant software and must
          never hold real client data.
        </p>
      </div>

      {reset && !stage ? (
        <p
          role="status"
          className="mt-6 rounded-[var(--radius)] border px-3 py-2 text-caption"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
        >
          Your password is set. Sign in with it — and note that every session your account had
          open has been ended, which is the point of a reset rather than a side effect of one.
        </p>
      ) : null}

      {claimed && !stage ? (
        <p
          role="status"
          className="mt-6 rounded-[var(--radius)] border px-3 py-2 text-caption"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
        >
          Your account is set up. Sign in with the password you just chose — setting it did not
          sign you in, which is the only ordering where the password is actually used to prove
          something.
        </p>
      ) : null}

      {stage?.stage === 'second_factor' ? (
        <Challenge name={stage.user.name} />
      ) : stage?.stage === 'enrol_second_factor' ? (
        <Enrolment name={stage.user.name} role={stage.user.role} />
      ) : (
        <Password />
      )}
    </main>
  );
}

async function Password() {
  return (
    <>
      <h1 className="mt-8 text-subhead font-semibold">Sign in</h1>
      <p className="mt-1 text-body text-muted">
        Clinical roles and the practice manager are asked for a second factor after this.
      </p>
      <PasswordForm />
      <p className="mt-3 text-caption">
        <Link href="/reset" className="underline">Forgotten your password?</Link>
      </p>
      <DemoAccounts />
    </>
  );
}

function Challenge({ name }: { name: string }) {
  return (
    <>
      <h1 className="mt-8 text-subhead font-semibold">One more step, {name}</h1>
      <p className="mt-1 text-body text-muted">
        Your password was accepted and nothing else has happened yet. This session reaches
        no client record until the code below is right.
      </p>
      <ChallengeForm />
      <p className="mt-4 text-caption text-subtle">
        Each code works once. A code you have already used is refused even inside its own
        30-second window — that is deliberate, and it is why one read over your shoulder is
        not a way in.
      </p>
    </>
  );
}

/**
 * Enrolment is mandatory rather than offered.
 *
 * "No second factor set up yet" must not be a way past the second factor, so a
 * role that requires one and has not enrolled lands here and can go nowhere
 * else. The account is signed in as far as its password takes it, which is
 * nowhere.
 */
async function Enrolment({ name, role }: { name: string; role: string }) {
  const { secret } = await enrolmentSecret();
  const grouped = secret.replace(/(.{4})/g, '$1 ').trim();

  return (
    <>
      <h1 className="mt-8 text-subhead font-semibold">Set up your second factor, {name}</h1>
      <p className="mt-1 text-body text-muted">
        {ROLE_LABEL[role] ?? role} accounts reach clinical records
        {role === 'admin' ? ' through break-glass' : ''}, so this one is required rather than
        optional. You cannot reach anything until it is done.
      </p>

      <div
        className="mt-5 rounded-[var(--radius-lg)] border p-4"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
      >
        <p className="text-caption font-medium">Add this key to an authenticator app</p>
        <p data-testid="totp-secret" className="mt-2 font-mono text-body break-all select-all">{grouped}</p>
        <p className="mt-2 text-caption text-subtle">
          Any TOTP app — the standard one, 30-second codes, six digits. Then type the code it
          shows to prove it worked. Nothing is saved to your account until you do, so closing
          this page leaves you exactly where you started.
        </p>
      </div>

      <EnrolmentForm />
    </>
  );
}

/**
 * The demo accounts, listed on the sign-in screen.
 *
 * Worth naming as the deliberate exception it is: putting valid usernames on a
 * login page is account enumeration served up voluntarily, and a real practice
 * must not do it. It is here because the alternative for a public learning
 * project is a door nobody can open, and because every account behind it holds
 * synthetic data and one published password. The rule it breaks is real, which
 * is why it says so rather than looking like a feature.
 */
async function DemoAccounts() {
  const users = await demoAccounts();
  if (users.length === 0) return null;

  return (
    <div className="mt-10 border-t pt-5" style={{ borderColor: 'var(--border)' }}>
      <p className="text-caption font-medium">Synthetic demo accounts</p>
      <p className="mt-1 text-caption text-subtle">
        Every one of them has the password <code className="select-all">{DEMO_PASSWORD}</code>.
        Listing accounts on a sign-in screen is exactly what a real deployment must not do —
        it hands an attacker the staff list. It is here because this is a public demo over
        invented data, and it is worth seeing named rather than quietly omitted.
      </p>
      <ul className="mt-3 space-y-1">
        {users.map((u) => (
          <li key={u.email} className="flex items-baseline justify-between gap-3 text-caption">
            <code className="select-all">{u.email}</code>
            <span className="text-muted">
              {ROLE_LABEL[u.role] ?? u.role}
              {requiresSecondFactor(u.role) ? ' · second factor required' : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
