import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, sql, USERS, userId } from './fixtures';

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

/**
 * Every page under `app/(staff)`, `[id]` segments included.
 *
 * They used to be excluded, on the grounds that "a `[id]` segment needs a real
 * record, and the record pages are the ones that already got this right". Both
 * halves turned out to be wrong. `/groups/[id]` called its getter with no actor
 * at all — no permission check, no audit row, a roster of six clients by name
 * and code to anybody with a cookie — and it survived precisely because this
 * sweep skipped it and the seed created no group for it to open. An excuse for
 * not covering something is where the next defect lives.
 *
 * A real record is not much to ask for: the seed is right there. What cannot be
 * inferred is *which* record — `/notes/[id]` is a ProgressNote and
 * `/submissions/[id]` a FormSubmission — so each dynamic route names its source
 * below, and a route with no entry fails the run rather than being skipped.
 */
function pageRoutes(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'page.tsx') out.push(prefix || '/');
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    out.push(...pageRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`));
  }
  return out;
}

/**
 * Where one real id comes from, per dynamic route. Ordered so the id is stable
 * between seeds — `createdAt` rather than the cuid, which is fresh every run.
 */
const ID_SOURCE: Record<string, string> = {
  '/appointments/[id]': 'select id from "Appointment" order by "startAt", id limit 1',
  '/clients/[id]': 'select id from "Client" order by code limit 1',
  '/clients/[id]/trends': 'select id from "Client" order by code limit 1',
  '/groups/[id]': 'select id from "GroupSession" order by "createdAt", id limit 1',
  '/notes/[id]': 'select id from "ProgressNote" order by "createdAt", id limit 1',
  '/process-notes/[id]': 'select id from "ProcessNote" order by "createdAt", id limit 1',
  '/submissions/[id]': 'select id from "FormSubmission" order by "createdAt", id limit 1',
};

const ALL = pageRoutes(STAFF).sort();
const DYNAMIC = ALL.filter((r) => r.includes('['));
const ROUTES = ALL.map((r) => (r.includes('[') ? r.replace('[id]', sql(ID_SOURCE[r]!)) : r));

test('the route tree is discovered, not assumed', () => {
  // A refactor that moves the pages should fail loudly here rather than
  // quietly reduce this spec to zero assertions.
  expect(ALL.length).toBeGreaterThanOrEqual(10);
  expect(ALL).toContain('/audit');

  // A dynamic page added next month is covered the day it lands, or this fails
  // and somebody says where its id comes from. What it must never do is drop
  // out of the sweep unnoticed, which is how `/groups/[id]` went unguarded.
  expect(DYNAMIC.filter((r) => !ID_SOURCE[r])).toEqual([]);
  expect(DYNAMIC.length).toBeGreaterThanOrEqual(7);

  // And each of those ids has to actually exist, or the sweep is walking URLs
  // that 404 for everybody and proving nothing.
  expect(ROUTES.filter((r) => r.includes('['))).toEqual([]);
  expect(ROUTES.filter((r) => r.endsWith('/') && r !== '/')).toEqual([]);
});

for (const [role, name] of Object.entries(USERS)) {
  test(`no route crashes for ${role}`, async ({ page }) => {
    const id = userId(name);
    await page.context().addCookies([
      { name: 'clearpath_user', value: id, url: 'http://localhost:3700' },
    ]);

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
