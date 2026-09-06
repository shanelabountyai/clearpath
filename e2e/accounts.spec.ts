import { execFileSync } from 'node:child_process';
import { actAs, expect, sql, test, USERS } from './fixtures';
import { CHOSEN_PASSWORD, uniqueEmail } from './accounts-fixture';

/**
 * Making an account exist, and the two channels it takes.
 *
 * The previous phase refuses a *reset* link to a clinical account that never
 * enrolled, because mailbox access alone would be a complete takeover — and
 * whoever used it would then enrol their own authenticator and hold the factor
 * from then on. A brand new clinical account is exactly that shape, so an
 * invitation cannot be a link and nothing else without reopening the door that
 * phase closed.
 *
 * These specs drive the real screens: the practice manager creates an account
 * and reads a code off the page, and the new person opens the link in a browser
 * that has never been signed in. What is demonstrated rather than asserted
 * about a function is that the link on its own gets nowhere.
 */

const fixture = () => execFileSync('npx', ['tsx', 'e2e/accounts-fixture.ts'], { stdio: 'pipe' });

test.beforeAll(fixture);
test.afterAll(fixture);

type Page = import('@playwright/test').Page;

/** Fill in the "Add someone" card and read both halves off the result. */
async function createAccount(page: Page, name: string, role: string) {
  const email = uniqueEmail(role);
  await page.goto('/practice');
  await page.fill('#new-name', name);
  await page.fill('#new-email', email);
  await page.selectOption('#new-role', role);
  await page.getByRole('button', { name: 'Create account and invite' }).click();

  const handover = page.getByRole('status').filter({ hasText: name });
  await expect(handover).toBeVisible();
  const text = await handover.innerText();

  const link = text.match(/http:\/\/\S*\/invite\/\S+/)?.[0];
  const code = text.match(/\b[0-9A-Z]{4}-[0-9A-Z]{4}\b/)?.[0];
  if (!link || !code) throw new Error(`no invitation on the page:\n${text}`);
  return { name, email, link, code };
}

/** Claim an account through the real screens, with both halves. */
async function claim(page: Page, link: string, code: string) {
  await asNobody(page, link);
  await page.fill('#code', code);
  await page.fill('#password', CHOSEN_PASSWORD);
  await page.fill('#confirm', CHOSEN_PASSWORD);
  await page.getByRole('button', { name: 'Set up my account' }).click();
}

/** A browser with no session at all — which is what a new person has. */
async function asNobody(page: Page, url: string) {
  await page.context().clearCookies();
  await page.goto(url);
}

test.describe('the two halves of a way in', () => {
  /**
   * The one the phase exists for. Somebody who can read the mailbox holds the
   * link and not the code, and there is no screen anywhere that will show them
   * the code — so the link reaches this page and stops.
   */
  test('the link alone reaches the screen and gets no further', async ({ page }) => {
    await actAs(page, USERS.manager);
    const account = await createAccount(page, 'Halle Brandt', 'therapist');

    await asNobody(page, account.link);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(account.name);
    await expect(page.locator('main')).toContainText('a short code somebody here gave you another way');

    await page.fill('#code', 'ZZZZ-ZZZZ');
    await page.fill('#password', CHOSEN_PASSWORD);
    await page.fill('#confirm', CHOSEN_PASSWORD);
    await page.getByRole('button', { name: 'Set up my account' }).click();

    // Named, so somebody mistyping a code read to them over the phone knows the
    // invitation is about to die rather than reporting that it "stopped working".
    await expect(page.locator('main')).toContainText('4 of 5 attempts left');

    // And the account still cannot be signed in to.
    await page.goto('/login');
    await page.fill('#email', account.email);
    await page.fill('#password', CHOSEN_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('main')).toContainText('do not match an account here');
  });

  /**
   * The second half arriving by the other channel, and what happens next: a
   * clinical account lands on mandatory enrolment at the front door. The factor
   * this flow never asked for is demanded before the account reaches anything.
   */
  test('both halves set up a clinical account, and the front door asks for the factor', async ({ page }) => {
    await actAs(page, USERS.manager);
    const account = await createAccount(page, 'Halle Brandt', 'therapist');

    // Typed the way somebody reads it off a note, not the way it was rendered.
    await claim(page, account.link, account.code.toLowerCase());

    // Signs nobody in. The password is used to prove something at the front
    // door or it has not been used to prove anything.
    await expect(page).toHaveURL(/\/login\?claimed=1/);
    await expect(page.locator('main')).toContainText('setting it did not sign you in');

    await page.fill('#email', account.email);
    await page.fill('#password', CHOSEN_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page.getByTestId('totp-secret')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('Sign out');
  });

  test('a front-desk account is set up the same way and signs straight in', async ({ page }) => {
    await actAs(page, USERS.manager);
    const account = await createAccount(page, 'Wynn Osborne', 'front_desk');
    await claim(page, account.link, account.code);

    await page.fill('#email', account.email);
    await page.fill('#password', CHOSEN_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('the link works once', async ({ page }) => {
    await actAs(page, USERS.manager);
    const account = await createAccount(page, 'Wynn Osborne', 'front_desk');
    await claim(page, account.link, account.code);
    await expect(page).toHaveURL(/\/login/);

    await asNobody(page, account.link);
    await expect(page).toHaveURL(/\/invite\?expired=1/);
    await expect(page.locator('main')).toContainText('no longer usable');
  });
});

test.describe('what the practice manager may and may not do', () => {
  /**
   * The line this module rests on. An account whose owner has set a password is
   * never invitable again, so there is no administrative action that puts an
   * established clinician's account into a state anybody else can claim.
   */
  test('cannot re-invite an account somebody has already claimed', async ({ page }) => {
    await actAs(page, USERS.manager);
    const account = await createAccount(page, 'Wynn Osborne', 'front_desk');
    await claim(page, account.link, account.code);
    await expect(page).toHaveURL(/\/login/);

    await actAs(page, USERS.manager);
    await page.goto('/practice');
    const row = page.getByRole('row').filter({ hasText: account.email });
    await expect(row).toContainText('Active');
    await expect(row.getByRole('button', { name: 'New invitation' })).toHaveCount(0);

    // And no seeded account offers one either — every one of them is claimed.
    //
    // Asserted per row rather than across the page. An earlier test in this file
    // leaves an unclaimed account behind on purpose, and it is correct for that
    // row to offer an invitation — a page-wide count would be asserting that no
    // unclaimed account exists anywhere, which is a fact about the other tests
    // rather than about this rule.
    for (const name of [USERS.frontDesk, USERS.therapist, USERS.manager]) {
      const seeded = page.getByRole('row').filter({ hasText: name });
      await expect(seeded.getByRole('button', { name: 'New invitation' })).toHaveCount(0);
    }
  });

  test('sends a new invitation to somebody who never used the first', async ({ page }) => {
    await actAs(page, USERS.manager);
    const first = await createAccount(page, 'Tobias Rennick', 'front_desk');

    await page.goto('/practice');
    const row = page.getByRole('row').filter({ hasText: first.email });
    await expect(row).toContainText('Invited');
    await row.getByRole('button', { name: 'New invitation' }).click();

    const handover = page.getByRole('status').filter({ hasText: first.name });
    await expect(handover).toBeVisible();
    const second = (await handover.innerText()).match(/\b[0-9A-Z]{4}-[0-9A-Z]{4}\b/)?.[0];
    expect(second).toBeTruthy();
    expect(second).not.toBe(first.code);

    // The one still sitting in a mailbox stops working the moment it is replaced.
    await asNobody(page, first.link);
    await expect(page).toHaveURL(/\/invite\?expired=1/);
  });

  /**
   * Somebody leaving. Their sessions end in the same transaction rather than
   * waiting out an idle timeout, and the account stays — their id is on every
   * audit row they made.
   */
  test('deactivating ends the account and keeps its trail', async ({ page }) => {
    await actAs(page, USERS.manager);
    const account = await createAccount(page, 'Tobias Rennick', 'front_desk');
    await claim(page, account.link, account.code);

    await actAs(page, USERS.manager);
    await page.goto('/practice');
    await page.getByRole('row').filter({ hasText: account.email })
      .getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByRole('row').filter({ hasText: account.email })).toContainText('Inactive');

    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('#email', account.email);
    await page.fill('#password', CHOSEN_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('main')).toContainText('do not match an account here');

    // The account and its trail are both still there.
    expect(sql(`select count(*) from "User" where email = '${account.email}'`)).toBe('1');
    expect(Number(sql(
      `select count(*) from "AuditEvent" where reason = 'deactivated' and "resourceId" in `
      + `(select id from "User" where email = '${account.email}')`,
    ))).toBeGreaterThan(0);
  });

  /**
   * The refusals the form is not the only thing enforcing. An associate whose
   * notes could never be countersigned would discover it after a session rather
   * than before one, which is the whole argument for checking it here.
   */
  test('refuses an associate with nobody to countersign their notes', async ({ page }) => {
    await actAs(page, USERS.manager);
    await page.goto('/practice');
    await page.fill('#new-name', 'Unsupervised Associate');
    const email = uniqueEmail('assoc');
    await page.fill('#new-email', email);
    await page.selectOption('#new-role', 'associate');
    // The field is required in the form for exactly this reason, so the refusal
    // has to be provoked by asking the server directly.
    await page.locator('#new-supervisor').evaluate((el: HTMLSelectElement) => { el.required = false; });
    await page.getByRole('button', { name: 'Create account and invite' }).click();

    // Scoped to `main`: Next's route announcer is also `role="alert"`, so the
    // bare role is ambiguous on any page reached by a client-side navigation.
    await expect(page.locator('main')).toContainText('needs a supervisor');
    expect(sql(`select count(*) from "User" where email = '${email}'`)).toBe('0');
  });

  test('refuses an address somebody already holds', async ({ page }) => {
    await actAs(page, USERS.manager);
    const existing = sql(`select email from "User" where name = '${USERS.therapist}'`);
    await page.goto('/practice');
    await page.fill('#new-name', 'Duplicate Address');
    await page.fill('#new-email', existing);
    await page.selectOption('#new-role', 'front_desk');
    await page.getByRole('button', { name: 'Create account and invite' }).click();

    await expect(page.locator('main')).toContainText('already has that address');
  });
});

/**
 * The surface is the practice manager's, and the matrix is what says so. Front
 * desk runs the calendar; a screen that can manufacture a role is not part of
 * running the calendar.
 */
test('nobody else reaches the account surface', async ({ page }) => {
  await actAs(page, USERS.frontDesk);
  await page.goto('/practice');
  await expect(page.locator('main')).not.toContainText('Add someone');
  await expect(page.locator('#new-email')).toHaveCount(0);
});
