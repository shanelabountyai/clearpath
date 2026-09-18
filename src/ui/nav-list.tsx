'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from './shell';

/**
 * The only client component in the staff shell, and it exists for exactly one
 * reason: `aria-current` needs to know the current path, and a server component
 * cannot read one. The permission matrix that decides which links exist stays
 * on the server — only href, label and glyph cross the boundary.
 */
/**
 * Which nav item the current path belongs to. Longest match wins, because the
 * prefix rule alone lights two: `/book/group` is under `/book`, and a detail
 * page like `/clients/abc` still belongs to Clients. Returns undefined for a
 * path no item owns — `/` has no nav entry and must not light anything.
 */
export function currentHref(items: NavItem[], pathname: string): string | undefined {
  return items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function NavList({ items }: { items: NavItem[] }) {
  const active = currentHref(items, usePathname());

  return (
    <nav aria-label="Sections" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const current = item.href === active;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? 'page' : undefined}
            className={`flex items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-1.5 text-body transition-colors hover:bg-[var(--surface-inset)] hover:text-ink ${
              current ? 'bg-[var(--surface-inset)] font-medium text-ink' : 'text-muted'
            }`}
          >
            <span aria-hidden className="w-4 text-center text-body text-subtle">{item.glyph}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
