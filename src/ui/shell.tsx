import Link from 'next/link';
import { may } from '../auth/guard';
import type { Actor } from '../auth/permissions';

interface NavItem {
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
  return (
    <nav aria-label="Sections" className="flex flex-col gap-0.5">
      {navFor(actor).map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="flex items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-1.5 text-body text-muted transition-colors hover:bg-[var(--surface-inset)] hover:text-ink"
        >
          <span aria-hidden className="w-4 text-center text-body text-subtle">{item.glyph}</span>
          {item.label}
        </Link>
      ))}
    </nav>
  );
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
