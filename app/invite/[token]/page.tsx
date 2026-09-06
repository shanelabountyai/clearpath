import { redirect } from 'next/navigation';
import { Wordmark } from '@/src/ui/logo';
import { systemClock } from '../../../src/clock';
import { resolveInvitation } from '../../../src/auth/accounts';
import { ClaimForm } from '../forms';

export const dynamic = 'force-dynamic';

/**
 * Claiming an account, and why the link alone gets no further than this page.
 *
 * The previous phase refused a *reset* link to a clinical account with no
 * second factor enrolled, because mailbox access alone would be a complete
 * takeover — and whoever used it would then enrol their own authenticator and
 * hold the factor from then on. A brand new clinical account is exactly that
 * shape, so an invitation cannot be a link and nothing else without reopening
 * the door that phase closed.
 *
 * What it is instead is two channels. This page is the end of the first one.
 * The second is a short code the practice manager reads out, and there is no
 * screen anywhere that will show it to whoever is holding the link.
 */
export default async function InviteTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await resolveInvitation(token, { clock: systemClock });
  // Unknown, expired, spent, superseded, burnt through its attempts,
  // deactivated, or an account claimed since — all one answer, for the reason
  // the reset page gives.
  if (!invitation) redirect('/invite?expired=1');

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <Wordmark practice="Stillwater Counseling — practice operations" />

      <h1 className="mt-8 text-subhead font-semibold">Welcome, {invitation.user.name}</h1>
      <p className="mt-1 text-body text-muted">
        This sets up your account at Stillwater Counseling. You need two things: this link,
        which arrived in your mailbox, and a short code somebody here gave you another way.
      </p>

      <ClaimForm token={token} />

      <div
        className="mt-8 rounded-[var(--radius-lg)] border p-4"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
      >
        <p className="text-caption font-medium">Why two things and not one</p>
        <p className="mt-2 text-caption text-muted">
          An email on its own has never been enough to reach a client record here. A link
          sitting in a mailbox proves somebody can read that mailbox, which is one thing and
          the weakest one in the building — so it is half of what this takes, and the code is
          the other half. Nobody who only has the link can get past this screen.
        </p>
        <p className="mt-2 text-caption text-muted">
          Setting a password does not sign you in. You will go to the sign-in page and use it
          there, and if your work involves client records you will set up an authenticator app
          before you can reach anything.
        </p>
      </div>
    </main>
  );
}
