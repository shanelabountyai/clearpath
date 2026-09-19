import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { actAs, expect, sql, test, USERS } from './fixtures';

/**
 * PRD 6, Q3: an automated accessibility check joins the e2e sweep. This is
 * the one check the token-contrast test in design-system.test.ts cannot do —
 * a missing label or an unreachable landmark renders fine and reads as
 * nothing to a screen reader, which is exactly the review's other twelve P1s.
 *
 * WCAG 2.2 AA is the target (the PRD's Q1), so the tag list is cumulative:
 * everything 2.0 AA and 2.1 AA carried, plus what 2.2 added. This is a floor,
 * not the conformance claim the Scope Honesty banner already rules out.
 */
const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const violations = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}`);
  expect(violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.describe('client-facing pages carry no WCAG 2.2 AA violation', () => {
  test('the enquiry form', async ({ page }) => {
    await page.goto('/enquire');
    await scan(page);
  });

  test('the intake/screener form', async ({ page }) => {
    const token = sql(`
      select r.token from "FormRequest" r
      join "FormTemplate" t on t.id = r."templateId"
      join "Client" c on c.id = r."clientId"
      where t.key = 'intake' and r.status <> 'submitted' and c.language = 'en'
      order by r.token limit 1`);
    test.skip(!token, 'no unsubmitted intake in the seed');
    await page.goto(`/f/${token}`);
    await scan(page);
  });

  test('the client portal', async ({ page }) => {
    const token = sql(`select token from "PortalLink" order by "createdAt" desc limit 1`);
    test.skip(!token, 'no portal link in the seed');
    await page.goto(`/p/${token}`);
    await scan(page);
  });
});

/**
 * One actor for most of the staff shell — admin reaches nearly everything the
 * matrix allows, and axe scans structure, not who is allowed to see it
 * (`permissions.test.ts` already owns that question). The audit log is the
 * one exception: admin does not carry `audit_log: read`, so that role would
 * scan the denial state, not the page this check means to cover.
 */
const STAFF_PAGES: [string, string, keyof typeof USERS][] = [
  ['the dashboard', '/', 'manager'],
  ['the calendar', '/calendar', 'frontDesk'],
  ['the client list', '/clients', 'therapist'],
  ['the booking flow', '/book', 'frontDesk'],
  ['the inquiry desk', '/inquiries', 'frontDesk'],
  ['worklists', '/worklists', 'frontDesk'],
  ['leave planning', '/leave', 'supervisor'],
  ['departure planning', '/departures', 'supervisor'],
  ['the co-sign queue', '/cosign', 'supervisor'],
  ['alerts', '/alerts', 'therapist'],
  ['reports', '/reports', 'manager'],
  ['forms admin', '/forms', 'manager'],
  ['practice settings', '/practice', 'manager'],
  ['the audit log', '/audit', 'auditor'],
];

test.describe('staff pages carry no WCAG 2.2 AA violation', () => {
  for (const [name, path, actor] of STAFF_PAGES) {
    test(name, async ({ page }) => {
      await actAs(page, USERS[actor]);
      await page.goto(path);
      await scan(page);
    });
  }
});
