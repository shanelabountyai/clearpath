import { actAs, clientId, expect, sql, test, USERS } from './fixtures';

/**
 * The 60-second demo, as a test.
 *
 * An associate signs a progress note, it reaches their supervisor's queue, the
 * supervisor co-signs it and is then refused the same client's process note,
 * and an auditor finds both events. If this passes, the project's central claim
 * holds end to end.
 */
test.describe('the access story', () => {
  test('an associate signs, a supervisor co-signs and is refused, and the auditor sees both', async ({ page }) => {
    const demoClient = clientId('TC-006');

    // 1. The associate signs their draft. Following the one note through is
    //    what makes the queue step mean something — the seeded queue already
    //    holds others, so a count would pass without this note ever arriving.
    const draft = sql(
      `select n.id from "ProgressNote" n
         join "Client" c on c.id = n."clientId"
        where c.code = 'TC-006' and n.status = 'draft'
        limit 1`,
    );
    expect(draft, 'the seed leaves the demo client one draft note').toBeTruthy();
    await actAs(page, USERS.associate);
    await page.goto(`/notes/${draft}`);
    await page.getByRole('button', { name: 'Sign' }).click();
    await expect(page.getByText('Pending co-signature')).toBeVisible();

    // 2. That note — not merely a note — is waiting in their supervisor's queue.
    await actAs(page, USERS.supervisor);
    await page.goto('/cosign');
    await expect(page.getByRole('heading', { name: 'Co-signature queue' })).toBeVisible();
    const row = page.locator('li').filter({ has: page.locator(`a[href="/notes/${draft}"]`) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Client 006');
    await expect(row.getByText(/waiting/)).toBeVisible();

    // 3. The supervisor co-signs it, and it leaves the queue.
    await row.getByRole('button', { name: 'Co-sign' }).click();
    await expect(page).toHaveURL(/\/cosign/);
    await expect(page.locator('li').filter({ has: page.locator(`a[href="/notes/${draft}"]`) })).toHaveCount(0);

    // 4. The same supervisor opens the same client's record. They can read it —
    //    supervision is clinical responsibility — and the process notes are not
    //    there, with the rule stated rather than an error.
    await page.goto(`/clients/${demoClient}`);
    await expect(page.getByRole('heading', { name: /Progress notes/ })).toBeVisible();
    await expect(page.getByText('Process notes by Priya Vance')).toBeVisible();
    await expect(page.getByText('not a permission you are missing')).toBeVisible();

    // 5. Reaching for it directly is a 403, presented as a locked drawer.
    const processNote = sql(`select id from "ProcessNote" where "clientId" = '${demoClient}' limit 1`);
    await page.goto(`/process-notes/${processNote}`);
    await expect(page.getByText('This process note is not yours')).toBeVisible();

    // 6. The auditor finds the denial and the co-signature.
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

  test('a client search never puts the name in the URL (PRD 1)', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/clients');
    const before = page.url();

    await page.getByLabel('Search clients').fill('client 006');
    await page.keyboard.press('Enter');

    const rows = page.getByRole('region', { name: 'Clients' }).locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('TC-006');
    expect(page.url()).toBe(before);
  });

  test('an auditor cannot open a client record', async ({ page }) => {
    await actAs(page, USERS.auditor);
    await page.goto(`/clients/${clientId('TC-006')}`);
    await expect(page.getByText('This is not one of your clients')).toBeVisible();
  });
});
