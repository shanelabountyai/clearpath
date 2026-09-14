import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { actAs, clientId, expect, sql, test, USERS, userId } from './fixtures';

/**
 * The seeded leave, lived through (leave PRD, Success Metrics → Lagging).
 *
 * Seeded on the real clock: Hana Lindqvist has been away two days with Dev
 * covering, and one client is split to Kai. A screener crossed its threshold
 * on day two and a text came in on day three, each routed on its own day. This
 * walks the window from the coverer's desk and front desk's, asks the day after
 * return on an advanced clock before anything has run, brings Hana back today,
 * and reads the trail as the auditor would.
 *
 * Ending the leave cannot be undone. `test:e2e` reseeds before every sweep;
 * rerunning this file alone needs `npm run db:seed:e2e` first. Hana is the
 * seed's own therapist for this, whom no other spec signs in as.
 */
const AWAY = 'Hana Lindqvist';
const COVERER = 'Dev Marchetti';
const SPLIT_TO = 'Kai Oyelaran';
const CODES = `('TC-086', 'TC-087', 'TC-088')`;
const PRIVATE = /still mine while I am away/;
const leaveId = () => sql(`select id from "Leave" where "userId" = '${userId(AWAY)}'`);
const alertOn = (code: string) => sql(
  `select u.name || ',' || coalesce(a."coveringLeaveId", '-') || ',' || (a."acknowledgedAt" is not null) from "Alert" a join "Client" c on c.id = a."clientId" join "User" u on u.id = a."recipientId" where c.code = '${code}'`,
);
/** The alert card: the innermost block holding both the client's code and its Acknowledge button. */
const card = (page: Page, code: string) => page.locator('div')
  .filter({ has: page.getByText(code, { exact: true }) })
  .filter({ has: page.getByRole('button', { name: 'Acknowledge' }) })
  .last();

test.describe('a seeded leave, from the first alert to the day after return', () => {
  test.describe.configure({ mode: 'serial' });

  test('the coverer is sent both alerts, and opens both records and the screener without breaking glass', async ({ page }) => {
    const leave = leaveId();
    expect(alertOn('TC-086')).toBe(`${COVERER},${leave},false`);
    expect(alertOn('TC-087')).toBe(`${COVERER},${leave},false`);

    await actAs(page, COVERER);
    await page.goto('/alerts');
    await card(page, 'TC-086').getByRole('link', { name: 'Read the response' }).click();
    await expect(page.getByText('Flagged for review')).toBeVisible();
    await expect(page.getByText('Screener responses are clinical')).toHaveCount(0);

    // Dev reads the text and acknowledges it; the screener's alert stays unread.
    await page.goto('/alerts');
    await card(page, 'TC-087').getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByText('TC-087', { exact: true })).toHaveCount(1);
    await expect.poll(() => alertOn('TC-087')).toBe(`${COVERER},${leave},true`);

    await page.goto('/clients');
    for (const code of ['TC-086', 'TC-087']) {
      await expect(page.locator('tr', { hasText: code })).toContainText('you cover until');
    }
    // Split to Kai: not Dev's to see.
    await expect(page.locator('tr', { hasText: 'TC-088' })).toHaveCount(0);

    await page.goto(`/clients/${clientId('TC-086')}`);
    await expect(page.getByText(`${AWAY} away until`)).toContainText(`covering: ${COVERER}`);
    await expect(page.getByText(PRIVATE)).toHaveCount(0);
    await page.goto(`/clients/${clientId('TC-087')}`);
    await expect(page.getByText('This is not one of your clients')).toHaveCount(0);

    expect(sql(`select count(*) from "AuditEvent" where "breakGlass" and "clientId" in (select id from "Client" where code in ${CODES})`)).toBe('0');
    expect(Number(sql(`select count(*) from "AuditEvent" where "actorId" = '${userId(COVERER)}' and reason = 'leave:${leave}'`))).toBeGreaterThan(0);
  });

  test('front desk tells a caller who covers, client by client, and sees Hana away', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${clientId('TC-088')}`);
    await expect(page.getByText(`${AWAY} away until`)).toContainText(`covering: ${SPLIT_TO}`);

    await page.goto('/leave');
    const row = page.locator('li', { hasText: AWAY });
    await expect(row).toContainText(`covering: ${COVERER}`);
    await expect(row).toContainText('1 client with somebody else');
    await expect(row).toContainText('away now');

    // P1-5: the work list counts the leave and names none of its clients (departure D-25).
    await page.goto('/worklists');
    const away = page.locator('section', { has: page.getByRole('heading', { name: 'Somebody is away' }) });
    await expect(away.locator('li', { hasText: AWAY })).toContainText(`covering: ${COVERER}`);
    await expect(away).not.toContainText('TC-08');
  });

  test('the day after the last, on an advanced clock, the record is refused before anything has run', async () => {
    const refused = execFileSync('node_modules/.bin/tsx', ['-e', `(async () => {
      const { getClient } = await import('./src/clients/repository.ts');
      const { fixedClock } = await import('./src/clock.ts');
      const { prisma } = await import('./src/db.ts');
      const { actor } = await import('./src/test/harness.ts');
      const { addDays, zonedToUtc } = await import('./src/time.ts');
      const leave = await prisma.leave.findUniqueOrThrow({ where: { id: '${leaveId()}' } });
      const dev = await prisma.user.findUniqueOrThrow({ where: { id: '${userId(COVERER)}' } });
      const back = fixedClock(zonedToUtc(addDays(leave.toDate.toISOString().slice(0, 10), 1), 12 * 60));
      const outcome = await getClient(actor(dev), '${clientId('TC-086')}', back).then(() => 'allowed', (e) => e.constructor.name);
      process.stdout.write(outcome);
      await prisma.$disconnect();
    })()`], { encoding: 'utf8' }).trim();

    expect(refused).toBe('Forbidden');
    // Nothing ran: the unread alert has not moved yet, and access did not wait for it.
    expect(alertOn('TC-086')).toBe(`${COVERER},${leaveId()},false`);
  });

  test('back today: the manager ends it, the coverer is refused, and only the unread alert goes home', async ({ page }) => {
    const leave = leaveId();
    await actAs(page, USERS.manager);
    await page.goto('/leave');
    await page.getByRole('link', { name: AWAY }).click();
    await page.getByRole('button', { name: `${AWAY} is back today` }).click();
    await expect(page.getByRole('heading', { name: 'Ended' })).toBeVisible();

    expect(alertOn('TC-086')).toBe(`${AWAY},-,false`);
    expect(alertOn('TC-087')).toBe(`${COVERER},${leave},true`);

    await actAs(page, COVERER);
    await page.goto(`/clients/${clientId('TC-086')}`);
    await expect(page.getByText('This is not one of your clients')).toBeVisible();

    // P1-4: Hana's first screen back is what happened while she was away.
    await actAs(page, AWAY);
    await page.goto('/');
    await expect(page).toHaveURL(/\/worklists$/);
    const back = page.locator('section', { has: page.getByRole('heading', { name: 'While you were away' }) });
    await expect(back.locator('li', { hasText: 'flagged for review' })).toContainText('TC-086');
    await expect(back.locator('li', { hasText: `Session with ${COVERER}` })).toContainText('TC-086');
    await expect(back.locator('li', { hasText: `Progress note by ${COVERER}` })).toContainText('TC-086');

    // And she can say she has read it, rather than waiting a fortnight for it to expire.
    await back.getByRole('button', { name: 'I have read this' }).click();
    await expect(page.getByRole('heading', { name: 'While you were away' })).toHaveCount(0);
  });

  test('the auditor lists the reads the leave made possible: the coverer\'s, none after return, and no private note', async ({ page }) => {
    const leave = leaveId();
    await actAs(page, USERS.auditor);
    await page.goto(`/audit?reason=leave:${leave}`);

    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasNotText: COVERER })).toHaveCount(0);

    expect(sql(`select count(*) from "AuditEvent" where reason = 'leave:${leave}' and at > (select max(at) from "AuditEvent" where reason = 'leave:dates_edited' and "resourceId" = '${leave}')`)).toBe('0');
    // Dev's record page lists Dev's own private notes on the client, filtered to
    // Dev in SQL, and that list is on the record. What must never appear is a
    // row naming Hana's note with anybody else as the reader.
    expect(sql(`select count(*) from "AuditEvent" where resource = 'process_note' and "actorId" <> '${userId(AWAY)}' and "resourceId" in (select id from "ProcessNote" where "authorId" = '${userId(AWAY)}')`)).toBe('0');
  });
});
