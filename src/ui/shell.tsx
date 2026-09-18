import { may } from '../auth/guard';
import { NavList } from './nav-list';
import type { Actor } from '../auth/permissions';

export interface NavItem {
  href: string;
  label: string;
  glyph: string;
}

/**
 * The navigation is derived from the permission matrix rather than from a
 * role switch, so a link a person cannot follow is never drawn. Same source of
 * truth as the endpoint that would refuse them — which means the menu cannot
 * drift from what the server actually allows.
 */
export function navFor(actor: Actor): NavItem[] {
  const items: [boolean, NavItem][] = [
    [
      may({ actor, action: 'read', resource: 'appointment' }),
      { href: '/calendar', label: 'Calendar', glyph: '◷' },
    ],
    [
      may({ actor, action: 'read', resource: 'client', target: { clinicianId: actor.id } }),
      { href: '/clients', label: 'Clients', glyph: '◫' },
    ],
    [
      may({ actor, action: 'create', resource: 'appointment' }),
      { href: '/book', label: 'Book a session', glyph: '＋' },
    ],
    [
      may({ actor, action: 'create', resource: 'appointment' }),
      { href: '/book/group', label: 'Book a group', glyph: '⁂' },
    ],
    [
      may({ actor, action: 'read', resource: 'alert', target: { recipientId: actor.id } }),
      { href: '/alerts', label: 'Alerts', glyph: '◆' },
    ],
    [
      may({
        actor, action: 'cosign', resource: 'progress_note',
        target: { authorId: 'someone-else', authorSupervisorId: actor.id },
      }),
      { href: '/cosign', label: 'Co-sign queue', glyph: '✍' },
    ],
    [
      may({ actor, action: 'read', resource: 'appointment' }),
      { href: '/worklists', label: 'Work lists', glyph: '☰' },
    ],
    [
      may({ actor, action: 'read', resource: 'inquiry' }),
      { href: '/inquiries', label: 'Enquiries', glyph: '☎' },
    ],
    [
      may({ actor, action: 'update', resource: 'form_template' }),
      { href: '/forms', label: 'Forms', glyph: '▤' },
    ],
    [
      may({ actor, action: 'read', resource: 'attendance_history' }),
      { href: '/reports', label: 'Reports', glyph: '▦' },
    ],
    [
      may({ actor, action: 'read', resource: 'departure' }),
      { href: '/departures', label: 'Departures', glyph: '⇥' },
    ],
    [
      may({ actor, action: 'read', resource: 'leave' }),
      { href: '/leave', label: 'Leave', glyph: '☾' },
    ],
    [
      may({ actor, action: 'read', resource: 'user' }),
      { href: '/practice', label: 'Practice', glyph: '⚙' },
    ],
    [
      may({ actor, action: 'read', resource: 'audit_log' }),
      { href: '/audit', label: 'Audit log', glyph: '⌸' },
    ],
  ];
  return items.filter(([allowed]) => allowed).map(([, item]) => item);
}

export function NavLinks({ actor }: { actor: Actor }) {
  return <NavList items={navFor(actor)} />;
}

export const ROLE_LABEL: Record<string, string> = {
  front_desk: 'Front desk',
  therapist: 'Therapist',
  associate: 'Associate',
  supervisor: 'Supervisor',
  admin: 'Practice manager',
  auditor: 'Auditor',
  client: 'Client',
};
