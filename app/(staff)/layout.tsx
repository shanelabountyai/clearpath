import Link from 'next/link';
import { currentSession, switchableUsers } from '../../src/session';
import { NavLinks, ROLE_LABEL } from '../../src/ui/shell';
import { endBreakGlass, switchUser } from '../actions';
import { Wordmark } from '@/src/ui/logo';
import { BreakGlassBar } from '@/src/ui/primitives';

export const dynamic = 'force-dynamic';

/**
 * The staff shell. The client-facing form pages sit outside this group and get
 * none of it -- no navigation, no identity switcher, nothing that suggests the
 * person holding a form link is looking at a practice's internal tool.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  const users = await switchableUsers();

  return (
    <>
      {!session ? (
        <main className="mx-auto max-w-xl px-6 py-16">
          <SignInPanel users={users} />
        </main>
      ) : (
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
              <UserSwitcher users={users} currentId={session.user.id} />
            </aside>

            <div className="min-w-0 flex-1">
              {session.actor.breakGlass && <BreakGlassBar reason={session.actor.breakGlass.reason} endAction={endBreakGlass} />}
              <main className="mx-auto max-w-[1200px] px-5 py-6">{children}</main>
            </div>
          </div>
      )}
    </>
  );
}

type SwitchUser = { id: string; name: string; role: string; supervisor: { name: string } | null };

function SignInPanel({ users }: { users: SwitchUser[] }) {
  return (
    <div>
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

      <p className="mt-6 text-body text-muted">
        There is no authentication here — pick a person and the app runs as them.
        Authorization is real: every screen below is decided by the same permission
        matrix a signed-in user would meet.
      </p>

      <ul className="mt-4 space-y-1.5">
        {users.map((u) => (
          <li key={u.id}>
            <form action={switchUser}>
              <input type="hidden" name="userId" value={u.id} />
              <button
                type="submit"
                className="flex w-full items-center justify-between rounded-[var(--radius)] border px-3 py-2 text-left transition-colors hover:bg-[var(--surface-inset)]"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
              >
                <span className="font-medium">{u.name}</span>
                <span className="text-caption text-muted">
                  {ROLE_LABEL[u.role]}
                  {u.supervisor ? ` · supervised by ${u.supervisor.name}` : ''}
                </span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Looks like a dev tool on purpose. It must never read as production chrome. */
function UserSwitcher({ users, currentId }: { users: SwitchUser[]; currentId: string }) {
  const current = users.find((u) => u.id === currentId);
  return (
    <form
      action={switchUser}
      className="rounded-[var(--radius)] border border-dashed p-2"
      style={{ borderColor: 'var(--border-strong)' }}
    >
      <label htmlFor="userId" className="block font-mono text-nano tracking-wide text-subtle uppercase">
        dev: acting as
      </label>
      <select
        id="userId"
        name="userId"
        defaultValue={currentId}
        className="mt-1 w-full rounded-[3px] border bg-[var(--surface-raised)] px-1.5 py-1 text-caption"
        style={{ borderColor: 'var(--border)' }}
      >
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} — {ROLE_LABEL[u.role]}
          </option>
        ))}
      </select>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-nano text-subtle">{current ? ROLE_LABEL[current.role] : ''}</span>
        <button type="submit" className="text-micro font-medium text-accent hover:underline">
          Switch
        </button>
      </div>
    </form>
  );
}

