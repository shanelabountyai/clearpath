import Link from 'next/link';
import { Wordmark } from '@/src/ui/logo';

export const dynamic = 'force-dynamic';

/**
 * Where a dead invitation lands, and the only page in the flow with no token.
 *
 * There is deliberately no form here. A reset has one — anybody can ask for a
 * link to their own mailbox — but an invitation is somebody else's decision:
 * the account may not exist yet, and a form that let a stranger ask for one
 * would be a way to find out whether an address is on the staff list, which is
 * the oracle the sign-in and the reset both go to some trouble to close.
 */
export default async function InviteExpiredPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <Wordmark practice="Stillwater Counseling — practice operations" />

      <h1 className="mt-8 text-subhead font-semibold">That invitation is no longer usable</h1>
      <p className="mt-1 text-body text-muted">
        It may have expired, been used already, been replaced by a newer one, or been closed
        after too many wrong codes. Ask the practice manager to send another — they can, and
        it takes them one click.
      </p>

      <p className="mt-6 text-caption text-subtle">
        If you have set this account up before and cannot get in, you want a{' '}
        <Link href="/reset" className="underline">password reset</Link> rather than a new
        invitation. An invitation only ever works on an account nobody has claimed.
      </p>

      <p className="mt-6 text-caption">
        <Link href="/login" className="underline">Back to sign in</Link>
      </p>
    </main>
  );
}
