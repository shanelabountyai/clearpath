import { actAs, expect, sql, test } from './fixtures';

/**
 * PRD 5: Sign opens a dialog, and backing out of it signs nothing. Only the
 * backing out is exercised here; the specs that sign go through `confirmClick`.
 */
test('Sign asks first, and Go back or Esc leaves the note a draft', async ({ page }) => {
  const [note, author] = sql(
    `select n.id || '|' || u.name from "ProgressNote" n join "User" u on u.id = n."authorId"
      where n.status = 'draft' limit 1`,
  ).split('|');
  expect(note, 'the seed leaves a draft progress note').toBeTruthy();

  await actAs(page, author!);
  await page.goto(`/notes/${note}`);

  const dialog = page.getByRole('dialog', { name: 'Sign this note?' });
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Go back' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  expect(sql(`select status from "ProgressNote" where id = '${note}'`)).toBe('draft');
});
