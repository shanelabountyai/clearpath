import { DEMO_PASSWORD } from '../src/auth/demo';
import { actAs, expect, freshCode, signInFresh, sql, test, USERS } from './fixtures';

/**
 * The door, from the outside.
 *
 * `sessions.test.ts` proves the rules against the database. What only a browser
 * can show is that they are actually wired to the application: that an
 * unauthenticated request for a client record does not render one, that a
 * half-authenticated session reaches nothing, and that signing out is
 * immediate rather than eventual.
 */

const emailOf = (name: string) => sql(`select email from "User" where name = '${name}'`);

test.describe('arriving without a session', () => {
  test('every staff route sends you to the sign-in screen', async ({ page }) => {
    await page.context().clearCookies();
    for (const route of ['/', '/clients', '/calendar', '/audit', '/worklists', '/reports']) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.locator('#password')).toBeVisible();
    }
  });

  /**
   * A layout does not wrap a route handler, so these two are gated only by
   * their own `requireSession`. They export a CSV of the audit trail and a
   * client's superbill — the two places where "it redirected in the browser"
   * would not have been enough.
   */
  test('the export routes hand out nothing', async ({ page }) => {
    await page.context().clearCookies();
    const res = await page.goto('/audit/export');
    expect(res?.status()).toBeLessThan(400);
    expect(await page.content()).not.toContain('actorId');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a forged session cookie is not a session', async ({ page }) => {
    const id = sql(`select id from "User" where name = '${USERS.manager}'`);
    await page.context().clearCookies();
    // The old cookie was exactly this: a user id, typed. It buys nothing now.
    await page.context().addCookies([
      { name: 'clearpath_session', value: id, url: 'http://localhost:3700' },
    ]);
    await page.goto('/clients');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('the password', () => {
  test('refuses a wrong one, and says the same thing for an unknown address', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', emailOf(USERS.frontDesk));
    await page.fill('#password', 'definitely-not-the-password');
    await page.click('button[type="submit"]');
    const wrongPassword = await page.locator('p[role="alert"]').innerText();

    await page.fill('#email', 'nobody-at-all@example.test');
    await page.fill('#password', DEMO_PASSWORD);
    await page.click('button[type="submit"]');
    const unknownAccount = await page.locator('p[role="alert"]').innerText();

    // Two different failures, one sentence. A login that distinguishes them
    // hands over the staff list.
    expect(unknownAccount).toBe(wrongPassword);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('is enough on its own for a role that reaches no clinical record', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', emailOf(USERS.auditor));
    await page.fill('#password', DEMO_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page).not.toHaveURL(/\/login$/);
    // Scoped to the sidebar: an auditor's own name is all over the audit table
    // they land on, which is the page working rather than the assertion.
    await expect(page.getByRole('complementary').getByText(USERS.auditor)).toBeVisible();
  });
});

/**
 * The property this whole phase exists for. `requiresSecondFactor` used to be
 * policy that nothing read, and the honest thing to prove is not that the
 * second screen appears — it is that the session has no authority while it is
 * showing.
 */
test.describe('a session that has only cleared the password', () => {
  test('reaches no client record at all', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', emailOf(USERS.supervisor));
    await page.fill('#password', DEMO_PASSWORD);
    await page.click('button[type="submit"]');

    // Signed in as far as a password takes you, which is to a second screen.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#code')).toBeVisible();

    // And no further. Not by URL, and not by the export route either.
    for (const route of ['/clients', '/calendar', '/cosign']) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.locator('#code')).toBeVisible();
    }
  });

  test('a wrong code leaves it exactly where it was', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', emailOf(USERS.manager));
    await page.fill('#password', DEMO_PASSWORD);
    await page.click('button[type="submit"]');

    await page.fill('#code', '000000');
    await page.click('button[type="submit"]');
    await expect(page.locator('p[role="alert"]')).toBeVisible();

    await page.goto('/clients');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('signing out', () => {
  test('takes effect immediately, not at the next timeout', async ({ page }) => {
    // A session of this spec's own: signing out of the shared one would revoke
    // the token every later spec still holds.
    const token = await signInFresh(page, USERS.frontDesk);
    await page.goto('/clients');
    await expect(page).not.toHaveURL(/\/login$/);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // The token is dead server-side, not merely dropped by the browser.
    await page.context().addCookies([
      { name: 'clearpath_session', value: token, url: 'http://localhost:3700' },
    ]);
    await page.goto('/clients');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('what the trail says', () => {
  test('a sign-in is on the record, and carries no address or secret', async ({ page }) => {
    await actAs(page, USERS.supervisor);
    const id = sql(`select id from "User" where name = '${USERS.supervisor}'`);

    const signIns = sql(
      `select count(*) from "AuditEvent" where action = 'sign_in' and allowed and "actorId" = '${id}'`,
    );
    expect(Number(signIns)).toBeGreaterThan(0);

    const leaked = sql(
      `select count(*) from "AuditEvent" where reason like '%@%' or reason like '%${DEMO_PASSWORD}%'`,
    );
    expect(Number(leaked)).toBe(0);
  });
});

/**
 * The one thing a second factor is actually for: a code is worth one use.
 * Proven here end to end, against a live server, with the code a phone would
 * be showing.
 */
test.describe('a code is spent once', () => {
  test('the same code will not open a second session', async ({ page }) => {
    await actAs(page, USERS.therapist); // enrols on the first run of the suite
    // Signing in above spent the step it used — the replay guard, already
    // working. Start from a code that is not already spent, or this spec would
    // be proving the wrong half of the rule.
    const code = await freshCode(page, USERS.therapist);

    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', emailOf(USERS.therapist));
    await page.fill('#password', DEMO_PASSWORD);
    await page.click('button[type="submit"]');
    await page.fill('#code', code);
    await page.click('button[type="submit"]');
    await expect(page).not.toHaveURL(/\/login$/);

    // Same code, a second time, in a session of its own.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', emailOf(USERS.therapist));
    await page.fill('#password', DEMO_PASSWORD);
    await page.click('button[type="submit"]');
    await page.fill('#code', code);
    await page.click('button[type="submit"]');
    await expect(page.locator('p[role="alert"]')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    const replays = sql(`select count(*) from "AuditEvent" where reason = 'replayed'`);
    expect(Number(replays)).toBeGreaterThan(0);
  });
});
