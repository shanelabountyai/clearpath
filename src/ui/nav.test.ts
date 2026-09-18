import { expect, it } from 'vitest';
import { currentHref } from './nav-list';

const items = [
  { href: '/book', label: 'Book a session', glyph: '＋' },
  { href: '/book/group', label: 'Book a group', glyph: '⁂' },
  { href: '/clients', label: 'Clients', glyph: '◫' },
];

/**
 * The prefix rule on its own lights two items for `/book/group`, which reads as
 * a broken menu and tells a screen reader there are two current pages.
 */
it('the nested item wins over the parent it sits under', () => {
  expect(currentHref(items, '/book/group')).toBe('/book/group');
  expect(currentHref(items, '/book')).toBe('/book');
});

it('a detail page still belongs to its section', () => {
  expect(currentHref(items, '/clients/abc123')).toBe('/clients');
});

it('a path no item owns lights nothing', () => {
  expect(currentHref(items, '/')).toBeUndefined();
  // Must not match on a bare string prefix: /bookkeeping is not /book.
  expect(currentHref(items, '/bookkeeping')).toBeUndefined();
});
