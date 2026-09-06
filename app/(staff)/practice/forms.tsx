'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/src/ui/button';
import {
  createAccountAction,
  reissueInvitationAction,
  type AccountState,
} from './actions';

/**
 * The practice manager's half of a two-channel invitation.
 *
 * The link goes to the new person's mailbox. The code appears here, once, and
 * has to get to them some other way — spoken across a desk, read out on a phone
 * call. That is the whole of what makes an invitation different from a link in
 * a mailbox, and the previous phase is the reason it has to be: a *reset* link
 * to a clinical account with no second factor is refused outright, because
 * mailbox access alone would be a complete takeover, and a brand new clinical
 * account is exactly that shape.
 *
 * So the screen has one job beyond collecting a name: say clearly that the code
 * must not be emailed. A copy button that put it on the clipboard next to a
 * mail client would be the affordance that quietly collapses the two channels
 * back into one, which is why there is not one.
 */

const INPUT = 'mt-1 w-full rounded-[var(--radius)] border px-3 py-2 text-body';
const INPUT_STYLE = { borderColor: 'var(--border)', background: 'var(--surface-raised)' };

export interface RoleOption {
  value: string;
  label: string;
  /**
   * Resolved by `supervisionRule` on the server, not decided here. A form that
   * worked out for itself which roles are supervised would be a component
   * drawing its own conclusion from a role — narrowly, in a way that only greys
   * out a control, and still the shape of scattered role logic hard rule 1
   * exists to keep out.
   */
  supervision: 'required' | 'optional' | 'none';
}
export interface SupervisorOption { id: string; name: string }

function Problem({ state }: { state: AccountState }) {
  if (!state || !('error' in state)) return null;
  return (
    <p
      role="alert"
      className="mt-3 rounded-[var(--radius)] border px-3 py-2 text-caption"
      style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
    >
      {state.error}
    </p>
  );
}

/**
 * The two halves, shown together so the difference between them is the thing
 * somebody reads rather than something they have to be told separately.
 */
function Handover({ state }: { state: AccountState }) {
  if (!state || !('invitation' in state)) return null;
  const { name, email, link, code } = state.invitation;

  return (
    <div
      role="status"
      className="mt-4 rounded-[var(--radius-lg)] border p-4"
      style={{ borderColor: 'var(--accent)', background: 'var(--surface-sunken)' }}
    >
      <p className="text-body font-medium">{name} can now set up their account.</p>

      <dl className="mt-3 space-y-3">
        <div>
          <dt className="text-caption font-medium">Sent to {email}</dt>
          <dd className="mt-1 break-all font-mono text-caption text-muted">{link}</dd>
        </div>
        <div>
          <dt className="text-caption font-medium">Read this out to them — do not email it</dt>
          <dd className="mt-1 font-mono text-subhead tracking-[0.2em]">{code}</dd>
        </div>
      </dl>

      <p className="mt-3 text-caption text-muted">
        This is the only time the code is shown. It is not stored anywhere it can be read
        back, and it is not in the email — that is the point of it. A link in a mailbox
        proves somebody can read that mailbox and nothing else, so it is half of what setting
        up an account takes here. If the code goes by email too, it is not.
      </p>
      <p className="mt-2 text-caption text-subtle">
        Lost it before they used it? Send a new invitation from their row; the old one stops
        working.
      </p>
    </div>
  );
}

export function NewAccountForm({
  roles,
  supervisors,
}: {
  roles: RoleOption[];
  supervisors: SupervisorOption[];
}) {
  const [state, action, pending] = useActionState<AccountState, FormData>(createAccountAction, undefined);
  const [selected, setSelected] = useState(roles[0]?.value ?? '');
  // Supervision means something for a caseload and nothing for the rest, and an
  // associate must have one — their progress notes are not a complete record
  // until a supervisor countersigns, and a note that can never be completed is
  // discovered after the session rather than before it. `accountComplaint`
  // refuses it either way; this only stops somebody walking into the refusal.
  const supervision = roles.find((r) => r.value === selected)?.supervision ?? 'none';

  return (
    <form action={action} className="mt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="new-name" className="block text-caption font-medium">Name</label>
          <input id="new-name" name="name" required className={INPUT} style={INPUT_STYLE} />
        </div>
        <div>
          <label htmlFor="new-email" className="block text-caption font-medium">Email</label>
          <input
            id="new-email" name="email" type="email" required autoComplete="off"
            className={INPUT} style={INPUT_STYLE}
          />
        </div>
        <div>
          <label htmlFor="new-role" className="block text-caption font-medium">Role</label>
          <select
            id="new-role" name="role" value={selected} onChange={(e) => setSelected(e.target.value)}
            className={INPUT} style={INPUT_STYLE}
          >
            {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="new-supervisor" className="block text-caption font-medium">
            Supervised by {supervision === 'required' ? '' : '(optional)'}
          </label>
          <select
            id="new-supervisor" name="supervisorId" disabled={supervision === 'none'}
            required={supervision === 'required'}
            className={INPUT}
            style={{ ...INPUT_STYLE, opacity: supervision === 'none' ? 0.5 : 1 }}
          >
            <option value="">{supervision === 'none' ? 'Not supervised' : 'Nobody'}</option>
            {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <Problem state={state} />
      <Handover state={state} />

      <Button type="submit" disabled={pending} className="mt-4">
        {pending ? 'Creating…' : 'Create account and invite'}
      </Button>
      <p className="mt-2 text-caption text-subtle">
        You are not setting their password, and there is no screen here that can. An
        administrator who could set one — and who can already clear a second factor — could
        sign in as any clinician in the building, and the audit log would record it as them.
      </p>
    </form>
  );
}

/**
 * The same handover again, for an invitation that expired or never arrived.
 *
 * Refused for an account whose owner has already set a password, and that
 * refusal is the one rule keeping an administrator from turning an established
 * clinician's account back into an invitable one. The button is simply not
 * drawn for those rows; a form post lands on the same refusal.
 */
export function ReissueForm({ userId, name, email }: { userId: string; name: string; email: string }) {
  const [state, action, pending] = useActionState<AccountState, FormData>(reissueInvitationAction, undefined);

  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="email" value={email} />
      <Button type="submit" variant="quiet" disabled={pending} className="text-caption">
        {pending ? 'Sending…' : 'New invitation'}
      </Button>
      <Problem state={state} />
      <Handover state={state} />
    </form>
  );
}
