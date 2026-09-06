import Link from 'next/link';
import { Wordmark } from '@/src/ui/logo';
import { RESET_TTL_MS } from '../../src/auth/recovery';
import { RequestForm } from './forms';
import { sentMessage } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Asking for a way back in.
 *
 * Outside the staff shell, like the sign-in, because nobody reaching it has a
 * session — that is the whole reason they are here.
 */
export default async function ResetRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  const { expired } = await searchParams;
  const minutes = Math.round(RESET_TTL_MS / 60_000);

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <Wordmark practice="Stillwater Counseling — practice operations" />

      {expired ? (
        <p
          role="alert"
          className="mt-6 rounded-[var(--radius)] border px-3 py-2 text-caption"
          style={{ borderColor: 'var(--warning)', background: 'var(--warning-soft)' }}
        >
          That link is no longer usable — it may have expired, been used already, or been
          replaced by a newer one. Ask for another below.
        </p>
      ) : null}

      <h1 className="mt-8 text-subhead font-semibold">Forgotten password</h1>
      <p className="mt-1 text-body text-muted">
        We will send a link to the address on the account. It lasts {minutes} minutes and works
        once.
      </p>

      <RequestForm sentMessage={await sentMessage()} />

      {/*
        The two things a link cannot do, said here rather than discovered.

        A clinical account is never reachable with one factor, and a link in a
        mailbox is one factor — so the link gets you to the same code challenge
        a correct password does, and an account that has never set up a second
        factor gets no link at all. The second is the case somebody has to ring
        about, and a page that stayed silent about it would leave them waiting
        on an email that is never coming.
      */}
      <div
        className="mt-8 rounded-[var(--radius-lg)] border p-4"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
      >
        <p className="text-caption font-medium">A link is not the whole way in</p>
        <ul className="mt-2 space-y-2 text-caption text-muted">
          <li>
            If your account needs a second factor, the link takes you to the same code
            challenge signing in does. An email on its own has never been enough to reach a
            client record here, and this does not make it enough.
          </li>
          <li>
            If you have lost your authenticator as well as your password, no link can help
            and none will be sent — there would be nothing left to prove it is you. Ring the
            practice manager, who can clear the second factor so you can set up a new one.
          </li>
        </ul>
      </div>

      <p className="mt-6 text-caption">
        <Link href="/login" className="underline">Back to sign in</Link>
      </p>
    </main>
  );
}
