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

  /**
   * P1-2. The warning arrives *after* the record, and says one thing: there is
   * a code worth looking at. No name, no clinician, no status — and the call is
   * on file either way, because a person on the phone is not made to wait.
   */
  test('a caller we may already know is flagged, by code and nothing else', async ({ page }) => {
    const last = caller();
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries');

    await page.getByLabel('First name').fill('Sam');
    await page.getByLabel('Last name').fill(last);
    // TC-001's number, straight out of the seed.
    await page.getByLabel('Phone').fill('555-0101');
    await page.getByRole('button', { name: 'Record the call' }).click();

    await expect(page.getByText('We may already know this person')).toBeVisible();
    await expect(page.getByRole('link', { name: 'TC-001' })).toBeVisible();
    // Warned, never blocked: the call is recorded and can still be converted.
    const row = page.locator('li', { hasText: last });
    await expect(row.getByText('open')).toBeVisible();
    await expect(row.getByRole('link', { name: 'Convert to client' })).toBeVisible();
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

  /**
   * P1-4. The seed's oldest discarded call clears the 90-day retention
   * default; the rest do not — so the badge has to pick out that one row,
   * not just appear because the filter is on discarded.
   */
  test('flags the discarded calls the next purge would destroy, and only those', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries?status=discarded');

    const due = page.locator('li', { hasText: 'Enquiry D15' });
    await expect(due.getByText('Due in next purge')).toBeVisible();

    const notDue = page.locator('li', { hasText: 'Enquiry D01' });
    await expect(notDue.getByText('Due in next purge')).toHaveCount(0);
  });
});
