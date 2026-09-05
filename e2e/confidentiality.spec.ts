import { actAs, clientId, expect, sql, test, USERS } from './fixtures';

/**
 * The 60-second demo, as a test.
 *
 * A supervisor co-signs an associate's progress note, is refused the same
 * client's process note, and an auditor finds both events. If this passes, the
 * project's central claim holds end to end.
 */
test.describe('the access story', () => {
  test('a supervisor co-signs, is refused, and the auditor sees both', async ({ page }) => {
    const demoClient = clientId('TC-006');

    // 1. The associate's note is waiting in their supervisor's queue.
    await actAs(page, USERS.supervisor);
    await page.goto('/cosign');
    await expect(page.getByRole('heading', { name: 'Co-signature queue' })).toBeVisible();
    const row = page.locator('li', { hasText: 'Client 006' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(/waiting/)).toBeVisible();
    // The queue is named rather than counted: a client can have more than one
    // note waiting, and this test is about the one it signs.
    const note = await row.locator('a[href^="/notes/"]').getAttribute('href');

    // 2. The supervisor co-signs it, and that note leaves the queue.
    await row.getByRole('button', { name: 'Co-sign' }).click();
    await expect(page).toHaveURL(/\/cosign/);
    await expect(page.locator(`li:has(a[href="${note}"])`)).toHaveCount(0);

    // 3. The same supervisor opens the same client's record. They can read it —
    //    supervision is clinical responsibility — and the process notes are not
    //    there, with the rule stated rather than an error.
    await page.goto(`/clients/${demoClient}`);
    await expect(page.getByRole('heading', { name: /Progress notes/ })).toBeVisible();
    await expect(page.getByText('Process notes by Priya Vance')).toBeVisible();
    await expect(page.getByText('not a permission you are missing')).toBeVisible();

    // 4. Reaching for it directly is a 403, presented as a locked drawer.
    const processNote = sql(`select id from "ProcessNote" where "clientId" = '${demoClient}' limit 1`);
    await page.goto(`/process-notes/${processNote}`);
    await expect(page.getByText('This process note is not yours')).toBeVisible();

    // 5. The auditor finds the denial and the co-signature.
    await actAs(page, USERS.auditor);
    await page.goto('/audit?denied=1&resource=process_note');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'process_note' }).first()).toBeVisible();
    await expect(page.getByText('denied').first()).toBeVisible();
  });

  test('the author reads their own process note', async ({ page }) => {
    const demoClient = clientId('TC-006');
    const processNote = sql(`select id from "ProcessNote" where "clientId" = '${demoClient}' limit 1`);
    await actAs(page, USERS.associate);
    await page.goto(`/process-notes/${processNote}`);
    await expect(page.getByRole('heading', { name: 'Process note' })).toBeVisible();
    await expect(page.getByText('This process note is not yours')).toHaveCount(0);
  });

  test('the practice manager must break glass, and still cannot reach a process note', async ({ page }) => {
    const demoClient = clientId('TC-006');
    await actAs(page, USERS.manager);

    await page.goto(`/clients/${demoClient}`);
    await expect(page.getByRole('heading', { name: 'Break-glass access required' })).toBeVisible();

    await page.getByLabel('Reason (required)').fill('client called the practice in distress, clinician on leave');
    await page.getByRole('button', { name: 'Break glass' }).click();

    await expect(page.getByText('Break-glass access is open.')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Client 006/ })).toBeVisible();

    const processNote = sql(`select id from "ProcessNote" where "clientId" = '${demoClient}' limit 1`);
    await page.goto(`/process-notes/${processNote}`);
    await expect(page.getByText('This process note is not yours')).toBeVisible();
  });

  test('front desk runs the calendar without clinical content', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${clientId('TC-006')}`);

    await expect(page.getByText('Operational')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Progress notes' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Screeners' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Attendance' })).toHaveCount(0);
    // They can still see that forms were sent and returned.
    await expect(page.getByRole('heading', { name: 'Forms' })).toBeVisible();
  });

  test('an auditor cannot open a client record', async ({ page }) => {
    await actAs(page, USERS.auditor);
    await page.goto(`/clients/${clientId('TC-006')}`);
    await expect(page.getByText('This is not one of your clients')).toBeVisible();
  });
});
