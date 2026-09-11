import type { Page } from '@playwright/test';
import { actAs, expect, sql, test, USERS, userId } from './fixtures';

/**
 * The leave plan screen, against the production build (leave PRD, Phase 4).
 *
 * `leave-plan.test.ts` proves what the service refuses and what the scan finds.
 * This proves the last inch: each control is drawn from the rule that would
 * refuse it — front desk reads who covers and is shown nothing to change — and
 * a refusal comes back as a sentence.
 *
 * The leave is a week out, so nobody's access or alerts move while it exists,
 * and the last test cancels it through the screen. `afterAll` cancels it the
 * way `cancelLeave` would, so a failure here cannot leave a leave behind.
 */
const AWAY = 'Tom Bergqvist';
const COVERER = 'Kai Oyelaran';
const SPLIT_TO = 'Rosa Iyer';
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
// By text: Next's route announcer is a `role="alert"` of its own.
const refusal = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });
const heading = (page: Page) => page.getByRole('heading', { name: `${AWAY} — leave` });

test.describe('a clinician away, and who covers', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(() => {
    const away = `'${userId(AWAY)}'`;
    sql(`update "Leave" set "cancelledAt" = now(), "overrideId" = null where "userId" = ${away} and "cancelledAt" is null`);
    sql(`delete from "AvailabilityOverride" o where o."userId" = ${away} and o.reason = 'Leave' and not exists (select 1 from "Leave" l where l."overrideId" = o.id)`);
  });

  test('the practice manager records a leave, splits a client, and is refused dates that run backwards', async ({ page }) => {
    await actAs(page, USERS.manager);
    await page.goto('/leave');
    await page.getByLabel('Who is away').selectOption({ label: AWAY });
    await page.getByLabel('First day away').fill(day(7));
    await page.getByLabel('Last day away').fill(day(14));
    await page.getByLabel('Who covers').selectOption({ label: COVERER });
    await page.getByRole('button', { name: 'Record leave' }).click();

    await expect(heading(page)).toBeVisible();
    await expect(page.getByText('Everybody covering is here for the rest of it')).toBeVisible();
    expect(sql(`select reason from "AvailabilityOverride" where "userId" = '${userId(AWAY)}' and reason = 'Leave'`)).toBe('Leave');

    const first = page.locator('li', { has: page.getByRole('button', { name: 'Save' }) }).first();
    await first.getByLabel('Covered by').selectOption({ label: SPLIT_TO });
    await first.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`Covered by ${SPLIT_TO}`)).toBeVisible();
    await expect(page.getByText(`Decided by ${USERS.manager}`)).toBeVisible();

    await page.getByLabel('Last day away').fill(day(3));
    await page.getByRole('button', { name: 'Move dates' }).click();
    await expect(refusal(page, 'cannot come before the first')).toBeVisible();
  });

  test('front desk reads who is away and who covers, and is shown nothing to change', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/leave');
    const row = page.locator('li', { hasText: AWAY });
    await expect(row).toContainText(`covering: ${COVERER}`);
    await expect(row).toContainText('1 client with somebody else');

    await row.getByRole('link', { name: AWAY }).click();
    await expect(heading(page)).toBeVisible();
    await expect(page.getByRole('button', { name: /Save|Name coverer|Move dates|Cancel leave|back today/ })).toHaveCount(0);
  });

  test('a therapist is not offered the list', async ({ page }) => {
    await actAs(page, USERS.therapist);
    await page.goto('/calendar');
    await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Leave' })).toHaveCount(0);
  });

  test('cancelling an upcoming leave gives its days back to the calendar', async ({ page }) => {
    await actAs(page, USERS.manager);
    await page.goto('/leave');
    await page.getByRole('link', { name: AWAY }).click();
    await page.getByRole('button', { name: 'Cancel leave' }).click();

    await expect(page.getByRole('heading', { name: 'Cancelled' })).toBeVisible();
    expect(sql(`select count(*) from "AvailabilityOverride" where "userId" = '${userId(AWAY)}' and reason = 'Leave'`)).toBe('0');
  });
});
