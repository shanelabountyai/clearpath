import { actAs, expect, sql, test, USERS, userId } from './fixtures';

/**
 * PRD 2: a save that fails leaves the text in the box. The session is the
 * failure that needs no fault injected — clear the cookie mid-edit, which is
 * what a sign-out in another tab does, and before this the redirect took the
 * note with it.
 */
test('a save with nobody signed in keeps the text, and the retry lands it', async ({ page }) => {
  const note = sql(
    `select id from "ProcessNote"
      where "authorId" = '${userId(USERS.associate)}' and "closedAt" is null
      limit 1`,
  );
  expect(note, 'the seed leaves the associate an open process note').toBeTruthy();
  const text = `Draft protection check ${Date.now()}`;

  await actAs(page, USERS.associate);
  await page.goto(`/process-notes/${note}`);
  await page.getByLabel('Note').fill(text);
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#save-failure')).toContainText('nobody is signed in');
  await expect(page.getByLabel('Note')).toHaveValue(text);

  await actAs(page, USERS.associate);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // The failure holds until the action returns, so its going is the save landing.
  await expect(page.locator('#save-failure')).toHaveCount(0);
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  // Review D2: the success is said, not only the failure.
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect(sql(`select content from "ProcessNote" where id = '${note}'`)).toBe(text);
});
