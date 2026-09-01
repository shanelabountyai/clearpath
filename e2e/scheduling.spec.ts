import { actAs, expect, test, USERS } from './fixtures';

test.describe('the calendar', () => {
  test('shows rooms as columns and telehealth in a lane of its own', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/calendar?date=2026-09-01');

    for (const room of ['Willow', 'Cedar', 'Linden', 'Aspen']) {
      await expect(page.getByText(room, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Telehealth', { exact: true })).toBeVisible();
    await expect(page.getByText('No room needed')).toBeVisible();
  });

  test('a cancellation states its consequence before the click', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/calendar');
    await page.locator('a[href^="/appointments/"]').first().click();

    await expect(page.getByRole('heading', { name: /Cancel/ })).toBeVisible();
    await expect(page.getByText(/late cancellation|Advance notice/)).toBeVisible();
  });

  test('the work lists surface an absence and its displaced clients', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    await expect(page.getByRole('heading', { name: 'Reschedules from clinician absence' })).toBeVisible();
    await expect(page.getByText('Annual leave')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Continuity of care' })).toBeVisible();
  });
});

test.describe('the client form', () => {
  test('is neutral, conditional and resumable', async ({ page, context }) => {
    const { sql } = await import('./fixtures');
    const token = sql(`
      select r.token from "FormRequest" r
      join "FormTemplate" t on t.id = r."templateId"
      where t.key = 'intake' and r.status <> 'submitted' limit 1`);
    test.skip(!token, 'no unsubmitted intake in the seed');

    await context.clearCookies();
    await page.goto(`/f/${token}`);

    await expect(page.getByText('New Client Intake')).toBeVisible();
    // Nothing on this page names the practice's speciality.
    await expect(page.getByText(/counsel/i)).toHaveCount(0);
    await expect(page.getByText('Stillwater', { exact: true })).toBeVisible();

    // A conditional branch stays shut until its parent opens it.
    await expect(page.getByText('Roughly when was that?')).toHaveCount(0);
    await page.getByRole('group', { name: /worked with a therapist before/ }).getByText('Yes').click();
    await expect(page.getByText('Roughly when was that?')).toBeVisible();

    await page.getByRole('button', { name: 'Save and finish later' }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();

    await page.reload();
    await expect(page.getByText('Roughly when was that?')).toBeVisible();
  });
});
