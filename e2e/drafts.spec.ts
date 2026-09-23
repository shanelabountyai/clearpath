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

/** §54: the amendment form keeps its text through a failed save too. */
test('an amendment with nobody signed in keeps the text', async ({ page }) => {
  // A progress note, not a process note: departure-demo purges the only closed process note.
  const note = sql(`select id from "ProgressNote" where status <> 'draft' order by id limit 1`);
  const author = sql(`select "authorId" from "ProgressNote" where id = '${note}'`);
  expect(note, 'the seed leaves a signed progress note to amend').toBeTruthy();
  const text = `Amendment protection check ${Date.now()}`;

  await page.context().addCookies([{ name: 'clearpath_user', value: author, url: 'http://localhost:3700' }]);
  await page.goto(`/notes/${note}`);
  await page.getByLabel('Amendment').fill(text);
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Add amendment' }).click();
  await expect(page.locator('#amend-failure')).toContainText('nobody is signed in');
  await expect(page.getByLabel('Amendment')).toHaveValue(text);
});

/** The browser's back button asks before it drops unsaved text; cancelling stays put. */
test('back asks before leaving a note with unsaved text', async ({ page }) => {
  const note = sql(
    `select id from "ProcessNote" where "authorId" = '${userId(USERS.associate)}' and "closedAt" is null limit 1`,
  );
  await actAs(page, USERS.associate);
  await page.goto('/calendar');
  await page.goto(`/process-notes/${note}`);
  await page.getByLabel('Note').fill(`Back check ${Date.now()}`);

  page.once('dialog', (d) => d.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/process-notes/${note}$`));
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.goBack();
  await expect(page).toHaveURL(/\/calendar/);
});
