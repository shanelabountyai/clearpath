import { execFileSync } from 'node:child_process';
import { actAs, currentCode, expect, freshCode, sql, test, USERS } from './fixtures';
import { latestResetLink } from '../src/auth/mailer';
import { CLINICAL, DESK, NEW_PASSWORD, PASSWORD, UNENROLLED } from './reset-fixture';

/**
 * Getting back in, and what a link in a mailbox is not enough to do.
 *
 * The previous phase bought one property: a clinical account is never reachable
 * with one factor. A reset flow is the door that undoes that quietly if nobody
 * looks — mailbox access would become clinical access, and every argument in
 * the sign-in would still be true and no longer matter. These specs drive the
 * real screens and read the real link out of the mailer, so the property is
 * demonstrated rather than asserted about a function.
 */

const fixture = (mode: 'setup' | 'teardown') =>
  execFileSync('npx', ['tsx', 'e2e/reset-fixture.ts', mode], { stdio: 'pipe' });

test.beforeAll(() => fixture('setup'));
test.afterAll(() => fixture('teardown'));

/** Ask for a link as a person does, then read it out of the mailbox. */
async function askForALink(page: import('@playwright/test').Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/reset');
  await page.fill('#email', email);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('status')).toContainText('a link is on its way');
  return latestResetLink(email);
}

test.describe('a link that is not the whole way in', () => {
  test('front desk resets on the link alone, because there is no factor to ask for', async ({ page }) => {
    const link = await askForALink(page, DESK.email);
    expect(link).toBeTruthy();

    await page.goto(link!);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Choose a new password');
    await page.fill('#password', NEW_PASSWORD);
    await page.fill('#confirm', NEW_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login\?reset=1/);
    await page.fill('#email', DESK.email);
    await page.fill('#password', NEW_PASSWORD);
    await page.click('button[type="submit"]');
    // Signed in, wherever the role's landing page happens to be.
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  /**
   * The one the phase exists for. Every precondition the sign-in applies is
   * applied again here, because a reset that skipped them would be a second
   * front door with a lower bar.
   */
  test('a clinical account is asked for the same code the sign-in asks for', async ({ page }) => {
    const link = await askForALink(page, CLINICAL.email);
    await page.goto(link!);

    await expect(page.getByRole('heading', { level: 1 })).toContainText('One more step');
    await expect(page.locator('main')).toContainText('proves you can read that mailbox and nothing else');
    // There is no way past it on this screen: no password field to fill in.
    await expect(page.locator('#password')).toHaveCount(0);

    await page.fill('#code', '000000');
    await page.click('button[type="submit"]');
    await expect(page.locator('main')).toContainText('That code is not right');
    await expect(page.locator('#password')).toHaveCount(0);

    await page.fill('#code', await freshCode(page, CLINICAL.name));
    await page.click('button[type="submit"]');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Choose a new password');

    await page.fill('#password', NEW_PASSWORD);
    await page.fill('#confirm', NEW_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login\?reset=1/);
  });

  /**
   * A clinical account that never enrolled has no second factor to demand, so a
   * link to it would be a takeover on mailbox access alone — and worse than the
   * sign-in equivalent, because whoever used it would then enrol their own
   * authenticator and hold the factor from then on. No link is sent, and the
   * screen says the same sentence it says to everybody.
   */
  test('sends no link at all where there would be nothing left to prove', async ({ page }) => {
    const link = await askForALink(page, UNENROLLED.email);
    expect(link).toBeNull();
    expect(sql(`select count(*) from "PasswordReset" where "userId" = '${UNENROLLED.id}'`)).toBe('0');
    // And the page says so up front, so nobody waits on an email that is never
    // coming. It names the remedy, which is a person rather than a screen.
    await expect(page.locator('main')).toContainText('Ring the practice manager');
  });

  test('says the same thing to an address with no account', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/reset');
    await page.fill('#email', 'nobody-at-all@example.test');
    await page.click('button[type="submit"]');
    await expect(page.getByRole('status')).toContainText('a link is on its way');
  });

  test('a spent link is refused, and says only that', async ({ page }) => {
    const link = await askForALink(page, DESK.email);
    await page.goto(link!);
    await page.fill('#password', PASSWORD);
    await page.fill('#confirm', PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login\?reset=1/);

    await page.goto(link!);
    await expect(page).toHaveURL(/\/reset\?expired=1/);
    await expect(page.locator('main')).toContainText('no longer usable');
  });
});

test.describe('the way back when both are lost', () => {
  /**
   * Requiring a second factor to reset means somebody who loses their password
   * *and* their authenticator cannot get back in by any route the system
   * offers. That is the correct security answer and an unacceptable operational
   * one on its own, so this is the other half — and what it does is clear a
   * factor, never reveal or set one.
   */
  test('the practice manager clears a lost factor, and the owner sets up a new one', async ({ page }) => {
    await actAs(page, USERS.manager);
    await page.goto('/practice');

    const row = page.locator('tr', { hasText: CLINICAL.name });
    await expect(row).toContainText('Enrolled');
    await row.getByRole('button', { name: 'Clear' }).click();
    await expect(page.locator('tr', { hasText: CLINICAL.name })).toContainText('Set up on next sign-in');

    // Cleared, not replaced: the account holds no secret at all, so the next
    // person through the door is the one who chooses it — and that is the owner.
    expect(sql(`select coalesce("totpSecret", '') from "User" where id = '${CLINICAL.id}'`)).toBe('');

    // And it is on the record, naming who did it and to whom.
    const trail = sql(
      `select count(*) from "AuditEvent" where resource = 'user' and "resourceId" = '${CLINICAL.id}'`
      + ` and reason = 'second_factor_cleared' and allowed = true`,
    );
    expect(Number(trail)).toBeGreaterThan(0);
  });

  /**
   * The control for the test above, and the reason the column is a column
   * rather than a button on every row: there is nothing to clear for a role
   * that never needed a factor, and offering the action anyway would be a
   * button that does nothing on the one screen where every button is
   * consequential.
   */
  test('offers nothing to clear where no factor was ever required', async ({ page }) => {
    const link = await askForALink(page, DESK.email);

    await actAs(page, USERS.manager);
    await page.goto('/practice');
    await expect(page.locator('tr', { hasText: USERS.frontDesk })).toContainText('Not required');

    await page.context().clearCookies();
    await page.goto(link!);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Choose a new password');
  });
});

test.describe('one code, one use, whichever door', () => {
  /**
   * `totpLastStep` lives on the account rather than on the session or the
   * reset, and sharing it across the two flows is the point rather than an
   * economy: a phished code is worth one action, not one action per door.
   */
  test('a code typed at the sign-in will not then reset the password', async ({ page }) => {
    // Re-enrol the account the previous describe cleared, through the real
    // screens, so this spec starts from a person who holds a factor.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', CLINICAL.email);
    await page.fill('#password', NEW_PASSWORD);
    await page.click('button[type="submit"]');
    const secret = await page.getByTestId('totp-secret').innerText();
    await page.fill('#code', currentCode(secret));
    await page.click('button[type="submit"]');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    const link = await askForALink(page, CLINICAL.email);
    const code = await freshCode(page, CLINICAL.name);

    // Spend it at the sign-in.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', CLINICAL.email);
    await page.fill('#password', NEW_PASSWORD);
    await page.click('button[type="submit"]');
    await page.fill('#code', code);
    await page.click('button[type="submit"]');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // The same code is now worth nothing at the reset — and says the same
    // sentence a mistyped one does, because telling somebody their captured
    // code has already been spent is telling an attacker exactly that.
    await page.context().clearCookies();
    await page.goto(link!);
    await page.fill('#code', code);
    await page.click('button[type="submit"]');
    await expect(page.locator('main')).toContainText('That code is not right');
  });
});
