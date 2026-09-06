import { redirect } from 'next/navigation';
import { Wordmark } from '@/src/ui/logo';
import { systemClock } from '../../../src/clock';
import { resolveReset } from '../../../src/auth/recovery';
import { NewPasswordForm, ResetCodeForm } from '../forms';

export const dynamic = 'force-dynamic';

/**
 * One route for the whole reset, rendering whichever step the link is actually
 * on — the same shape as the sign-in, and for the same reason: routing the
 * stages from one place is what keeps "which of these may set a password" a
 * question with one answer.
 *
 * `resolveReset` returns no `Actor` in any variant and there is no `ready`
 * stage to reach. This page cannot authorize anything, and nothing downstream
 * of it exists.
 */
export default async function ResetTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const reset = await resolveReset(token, { clock: systemClock });
  // Unknown, expired, spent, superseded, deactivated, or a factor cleared since
  // it was sent — all one answer. A page that distinguished them would be the
  // same enumeration oracle in a smaller window.
  if (!reset) redirect('/reset?expired=1');

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <Wordmark practice="Stillwater Counseling — practice operations" />

      {reset.stage === 'second_factor' ? (
        <>
          <h1 className="mt-8 text-subhead font-semibold">One more step, {reset.user.name}</h1>
          <p className="mt-1 text-body text-muted">
            The link proves you can read that mailbox and nothing else. Your account reaches
            client records, so it takes a second factor to change its password — the same code
            signing in asks for.
          </p>
          <ResetCodeForm token={token} />
          <p className="mt-4 text-caption text-subtle">
            Each code works once, at whichever door it is used. A code you have just typed into
            the sign-in will not work here, and one typed here will not work there.
          </p>
        </>
      ) : (
        <>
          <h1 className="mt-8 text-subhead font-semibold">Choose a new password, {reset.user.name}</h1>
          <p className="mt-1 text-body text-muted">
            Setting this ends every session your account has open, including any this link did
            not start. Then sign in with it.
          </p>
          <NewPasswordForm token={token} />
        </>
      )}
    </main>
  );
}
