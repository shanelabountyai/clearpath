import Link from 'next/link';
import { requireSession } from '../../src/session';
import { NavLinks, ROLE_LABEL } from '../../src/ui/shell';
import { endBreakGlass } from '../actions';
import { signOutAction } from '../login/actions';
import { Wordmark } from '@/src/ui/logo';
import { BreakGlassBar } from '@/src/ui/primitives';

export const dynamic = 'force-dynamic';

/**
 * The staff shell. The client-facing form pages sit outside this group and get
 * none of it -- no navigation, no identity, nothing that suggests the person
 * holding a form link is looking at a practice's internal tool.
 *
 * This used to render a person picker when nobody was selected, because there
 * was nobody to be signed in *as*. It now requires a session and redirects to
 * `/login` without one, which means the layout no longer has an unauthenticated
 * branch at all — the shell either has an actor or does not render.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen">
      <aside
        className="hidden w-56 shrink-0 flex-col justify-between border-r px-3 py-4 md:flex"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
      >
        <div>
          <Link href="/" className="mb-5 block px-2.5">
            <Wordmark practice="Stillwater Counseling" size="sm" />
          </Link>
          <NavLinks actor={session.actor} />
        </div>
        <SignedInAs
          name={session.user.name}
          role={session.user.role}
          secondFactor={session.secondFactor}
        />
      </aside>

      <div className="min-w-0 flex-1">
        {session.actor.breakGlass && (
          <BreakGlassBar reason={session.actor.breakGlass.reason} endAction={endBreakGlass} />
        )}
        <main className="mx-auto max-w-[1200px] px-5 py-6">{children}</main>
      </div>
    </div>
  );
}

/**
 * Who you are, and the way out.
 *
 * The dashed dev-tool border this replaces was load-bearing honesty: it said
 * "this is a switcher, not a login". It is gone because the thing it was
 * disclaiming is gone. What stays is the second-factor line, which now reports
 * a fact instead of a gap.
 */
function SignedInAs({
  name,
  role,
  secondFactor,
}: {
  name: string;
  role: string;
  secondFactor: { required: boolean; satisfied: boolean };
}) {
  return (
    <div
      className="rounded-[var(--radius)] border p-2.5"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
    >
      <p className="text-caption font-medium">{name}</p>
      <p className="text-micro text-muted">{ROLE_LABEL[role] ?? role}</p>
      {secondFactor.required && secondFactor.satisfied && (
        <p className="mt-1 text-nano tracking-wide text-subtle uppercase" title="This role requires a second factor, and this session satisfied it.">
          two factors
        </p>
      )}
      <form action={signOutAction} className="mt-2">
        <button type="submit" className="text-micro font-medium text-accent hover:underline">
          Sign out
        </button>
      </form>
    </div>
  );
}
