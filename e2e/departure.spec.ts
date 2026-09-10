import type { Page } from '@playwright/test';
import { actAs, expect, sql, test, USERS } from './fixtures';

/**
 * The plan screen, against the production build (departure PRD, Phase 4).
 *
 * `departure.test.ts` proves what the service refuses. This proves the last
 * inch: that each control is drawn from the rule that would refuse it — front
 * desk reads a plan and is shown nothing to change, only the practice manager
 * is shown Execute — and that a refusal comes back as a sentence rather than a
 * crash page.
 *
 * The leaver is a seeded therapist no other spec touches. Whatever happens
 * here, `afterAll` withdraws the notice the way `cancelDeparture` would, so a
 * failure in this file cannot leave a closed clinician behind for the next.
 */
const LEAVER = 'Tom Bergqvist';
// By text: Next's route announcer is a `role="alert"` of its own.
const refusal = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });
const lastDay = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

test.describe('a clinician leaving', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(() => {
    const leaver = `(select id from "User" where name = '${LEAVER}')`;
    sql(`update "User" u set "acceptingNewClients" = d."acceptingNewClientsAtNotice" from "Departure" d where d."userId" = u.id and d.status = 'planned' and u.id = ${leaver}`);
    sql(`update "Departure" set status = 'cancelled' where status = 'planned' and "userId" = ${leaver}`);
  });

  test('the practice manager records notice, decides, and is refused before the plan is ready', async ({ page }) => {
    await actAs(page, USERS.manager);
    await page.goto('/departures');
    await page.getByLabel('Who is leaving').selectOption({ label: LEAVER });
    await page.getByLabel('Last day').fill(lastDay);
    await page.getByRole('button', { name: 'Record notice' }).click();

    await expect(page.getByRole('heading', { name: `${LEAVER} is leaving` })).toBeVisible();
    await expect(page.getByText('12 clients with no decision')).toBeVisible();

    const undecided = () => page.locator('li', { has: page.getByRole('button', { name: 'Decide' }) });
    const first = undecided().first();
    await first.getByLabel('Decision').selectOption('discharge');
    await first.getByRole('button', { name: 'Decide' }).click();
    await expect(page.getByText('11 clients with no decision')).toBeVisible();

    // A transfer with nobody receiving it: refused, in words, and nothing written.
    await undecided().first().getByRole('button', { name: 'Decide' }).click();
    await expect(refusal(page, 'cannot take this on')).toBeVisible();
    await expect(page.getByText('11 clients with no decision')).toBeVisible();

    await page.getByRole('button', { name: 'Execute departure' }).click();
    await expect(refusal(page, 'Nothing moved')).toBeVisible();
  });

  test('front desk reads the plan and is shown nothing to change', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/departures');
    await page.getByRole('link', { name: LEAVER }).click();

    await expect(page.getByRole('heading', { name: `${LEAVER} is leaving` })).toBeVisible();
    await expect(page.getByRole('button', { name: /Decide|Change|Execute departure|Withdraw notice/ })).toHaveCount(0);
    // The person picker marks them, with the day (P0-9).
    await expect(page.locator('#userId option', { hasText: LEAVER })).toContainText('leaving, last day');
  });

  test('the leaver is sent to their own unsigned notes', async ({ page }) => {
    await actAs(page, LEAVER);
    await page.goto('/calendar');
    await page.getByRole('link', { name: /Your last day is/ }).click();
    await expect(page.getByRole('heading', { name: 'Your unsigned notes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Execute departure' })).toHaveCount(0);
  });

  test('withdrawing notice puts the books back and ends the plan', async ({ page }) => {
    await actAs(page, USERS.manager);
    await page.goto('/departures');
    await page.locator('li', { hasText: 'planned' }).getByRole('link', { name: LEAVER }).click();
    await page.getByRole('button', { name: 'Withdraw notice' }).click();
    await expect(page.getByRole('heading', { name: 'Withdrawn' })).toBeVisible();
    expect(sql(`select "acceptingNewClients" from "User" where name = '${LEAVER}'`)).toBe('t');
  });
});
