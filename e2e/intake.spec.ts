import { actAs, expect, test, USERS } from './fixtures';

/**
 * Who may end a call, and who may only take one.
 *
 * The matrix says a clinician creates enquiries and does not discard them, and
 * `permissions.test.ts` already proves the rule. What this proves is the last
 * inch: that the page draws its controls from the same rule rather than from a
 * role check, so a clinician is never shown a Discard button that the server
 * would refuse. A drawn-but-refused control is the failure mode this whole
 * project is arguing against.
 */
test.describe('the intake desk', () => {
  const caller = () => `Caller${Date.now().toString().slice(-6)}`;

  test('a clinician records a call and cannot end one', async ({ page }) => {
    const last = caller();
    await actAs(page, USERS.therapist);
    await page.goto('/inquiries');

    await page.getByLabel('First name').fill('Sam');
    await page.getByLabel('Last name').fill(last);
    await page.getByLabel('Phone').fill('555-0100');
    await page.getByRole('button', { name: 'Record the call' }).click();

    const row = page.locator('li', { hasText: last });
    await expect(row).toBeVisible();
    await expect(row.getByText('open')).toBeVisible();

    // The two things a clinician is not: the person who ends a call, and the
    // person who turns one into a client record.
    await expect(row.getByRole('button', { name: 'Discard' })).toHaveCount(0);
    await expect(row.getByRole('link', { name: 'Convert to client' })).toHaveCount(0);
  });

  test('front desk ends one with a reason code, and it is a code', async ({ page }) => {
    const last = caller();
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries');

    await page.getByLabel('First name').fill('Alex');
    await page.getByLabel('Last name').fill(last);
    await page.getByRole('button', { name: 'Record the call' }).click();

    const row = page.locator('li', { hasText: last });
    await expect(row.getByRole('link', { name: 'Convert to client' })).toBeVisible();

    // No free-text box anywhere near this: the reason is chosen from a fixed
    // vocabulary, which is what makes "why do enquiries not convert" a
    // question the reports page can answer.
    await row.getByLabel('Why this enquiry ended').selectOption('no_capacity');
    await row.getByRole('button', { name: 'Discard' }).click();

    const ended = page.locator('li', { hasText: last });
    await expect(ended.getByText('discarded')).toBeVisible();
    await expect(ended.getByText('No capacity')).toBeVisible();
    // Terminal: there is no way back to a client from here.
    await expect(ended.getByRole('link', { name: 'Convert to client' })).toHaveCount(0);
  });
});
