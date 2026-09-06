import { DEMO_PASSWORD } from '../src/auth/demo';
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

    // The door, half open. A supervisor whose password was accepted and who has
    // proved nothing else — the screen says what this session can reach, which
    // is nothing.
    //
    // The challenge rather than the enrolment screen, and `actAs` first is what
    // makes it the challenge: the seed enrols nobody, so a first sign-in would
    // land on enrolment and photograph a TOTP secret. Invented or not, a secret
    // in a README teaches the wrong habit.
    await actAs(page, USERS.supervisor);
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', sql(`select email from "User" where name = '${USERS.supervisor}'`));
    await page.fill('#password', DEMO_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('#code')).toBeVisible();
    await expect(page.getByTestId('totp-secret')).toHaveCount(0);
    await page.screenshot({ path: `${shot}/second-factor.png` });

    // The operational tier: front desk runs the whole calendar and learns
    // nothing about why anyone is in the building.
    await actAs(page, USERS.frontDesk);
    // The busiest seeded weekday, so the picture shows a working practice
    // rather than whatever today happens to hold.
    const busiest = sql(
      `select to_char("startAt", 'YYYY-MM-DD') from "Appointment" group by 1 order by count(*) desc, 1 limit 1`,
    );
    await page.goto(`/calendar?date=${busiest}`);
    await expect(page.getByText(/[1-9]\d* sessions ·/)).toBeVisible();
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

    // ── the confirmation loop, which is most of what this project is now ──
    //
    // Four phases of it were invisible in the README: the reminder cadence,
    // the fee for silence, the carrier that has to prove delivery, and two
    // languages. These are the pictures of that.

    // The half a practice should ship before the money: a list somebody works
    // with a phone, and above it the clients who wrote back in words nobody
    // here is allowed to read.
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    await expect(page.getByRole('heading', { name: 'Unconfirmed, starting soon' })).toBeVisible();
    // Full page: the three lists are the point, and the third sits below the
    // fold at any sane viewport.
    await page.screenshot({ path: `${shot}/work-lists.png`, fullPage: true });

    // The client's own door, in the language the reminder was written in.
    // Chosen rather than hoped for: a Spanish-speaking client with a live link
    // and something still to answer.
    const spanishToken = sql(
      `select l.token from "PortalLink" l join "Client" c on c.id = l."clientId"`
      + ` where c.language = 'es' and l."expiresAt" > now()`
      + ` and exists (select 1 from "Appointment" a where a."clientId" = c.id`
      + `   and a.confirmation = 'pending' and a."startAt" > now())`
      + ` order by l."expiresAt" desc limit 1`,
    );
    if (spanishToken) {
      await page.context().clearCookies();
      await page.goto(`/p/${spanishToken}`);
      await expect(page.getByRole('heading', { name: /^Hola / })).toBeVisible();
      await page.screenshot({ path: `${shot}/client-door-es.png` });
    }

    // And what the policy actually did, for the person deciding whether to
    // keep it: the rates, the money, and the sessions it stood down on.
    await actAs(page, USERS.manager);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Confirmation' })).toBeVisible();
    await page.locator('section, .lg\\:col-span-2').filter({ hasText: 'Confirmation' }).first()
      .screenshot({ path: `${shot}/confirmation-report.png` });
  });
});
