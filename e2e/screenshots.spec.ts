import { actAs, clientId, expect, sql, test, USERS } from './fixtures';

/**
 * Not an assertion — the README's pictures, captured from the same seeded
 * practice the specs run against, so they cannot drift from the product
 * without a rebuild. `npm run shots`; skipped in the ordinary sweep.
 */
test.describe('README screenshots', () => {
  test.skip(!process.env.SHOTS, 'capture only');

  const shot = 'docs/screenshots';

  test('capture', async ({ page }) => {
    const demoClient = clientId('TC-006');

    // The operational tier: front desk runs the whole calendar and learns
    // nothing about why anyone is in the building.
    await actAs(page, USERS.frontDesk);
    // The busiest seeded weekday, so the picture shows a working practice
    // rather than whatever today happens to hold.
    const busiest = sql(
      `select to_char("startAt", 'YYYY-MM-DD') from "Appointment" group by 1 order by count(*) desc, 1 limit 1`,
    );
    await page.goto(`/calendar?date=${busiest}`);
    await expect(page.getByText(/[1-9]\d* sessions( in [1-9]\d* bookings)? ·/)).toBeVisible();
    await page.screenshot({ path: `${shot}/calendar-front-desk.png` });

    // The rule, stated where the notes would be, to the supervisor of the
    // clinician who wrote them.
    await actAs(page, USERS.supervisor);
    await page.goto(`/clients/${demoClient}`);
    const locked = page.locator('section[aria-labelledby="locked-title"]');
    await expect(locked).toBeVisible();
    await locked.screenshot({ path: `${shot}/process-notes-locked.png` });

    // Administration reaches a clinical record only through a logged door.
    await actAs(page, USERS.manager);
    await page.goto(`/clients/${demoClient}`);
    await expect(page.getByRole('heading', { name: 'Break-glass access required' })).toBeVisible();
    await page.screenshot({ path: `${shot}/break-glass.png` });

    // And the auditor sees the refusal without seeing what was refused.
    await actAs(page, USERS.auditor);
    await page.goto('/audit?denied=1&resource=process_note');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    // Every other pixel here is deterministic — the seed is date-pinned. The
    // audit row's stamp is not, because `at` defaults to the database clock
    // rather than the app's, which is the one timestamp the app should not get
    // to choose. Masked, so a diff on this picture means the product moved.
    await page.screenshot({
      path: `${shot}/audit-log.png`,
      mask: [page.locator('tbody td:first-child')],
      maskColor: '#a8a29a',
    });
  });
});
