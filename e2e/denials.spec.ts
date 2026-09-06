import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, USERS, actAs } from './fixtures';

/**
 * Every static staff route, as every seeded person, must answer.
 *
 * The record pages caught `Forbidden` and rendered a panel. The list pages did
 * not, so eight of them — /audit, /clients, /calendar, /book, /alerts,
 * /reports, /practice, /worklists — returned a 500 crash page to any role the
 * matrix refused. Every permission decision was correct and every denial was
 * logged; the suite still passed, because nothing asked what a list page does
 * when the answer is no.
 *
 * So this walks the route tree rather than naming routes. A page added next
 * month is covered the day it is added, which is the only version of this test
 * worth having: the eight that broke were each written after the pattern that
 * would have saved them.
 */

// `package.json` sets `"type": "module"`, so there is no `__dirname` here.
const HERE = path.dirname(new URL(import.meta.url).pathname);
const STAFF = path.join(HERE, '..', 'app', '(staff)');

/** Static routes only — a `[id]` segment needs a real record, and the record
 *  pages are the ones that already got this right. */
function staticRoutes(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'page.tsx') out.push(prefix || '/');
    if (!entry.isDirectory() || entry.name.startsWith('[') || entry.name.startsWith('_')) continue;
    out.push(...staticRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`));
  }
  return out;
}

const ROUTES = staticRoutes(STAFF).sort();

test('the route tree is discovered, not assumed', () => {
  // A refactor that moves the pages should fail loudly here rather than
  // quietly reduce this spec to zero assertions.
  expect(ROUTES.length).toBeGreaterThanOrEqual(10);
  expect(ROUTES).toContain('/audit');
});

for (const [role, name] of Object.entries(USERS)) {
  test(`no route crashes for ${role}`, async ({ page }) => {
    await actAs(page, name);

    const crashed: string[] = [];
    for (const route of ROUTES) {
      const res = await page.goto(route, { waitUntil: 'commit' });
      const status = res?.status() ?? 0;
      if (status >= 500) crashed.push(`${route} → ${status}`);
    }

    // Named in the failure, because "one of eleven routes broke" is not a
    // starting point for anybody.
    expect(crashed, `${name} (${role}) hit a server error`).toEqual([]);
  });
}
