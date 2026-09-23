import { actAs, expect, sql, test, USERS } from './fixtures';

/**
 * The public enquiry form, driven the way a stranger drives it: no cookie, no
 * token, no link that was ever sent to them.
 *
 * Every test clears the throttle table first. The limit is three an hour per
 * submitter and Playwright is one submitter, so without that reset the fourth
 * test in this file would be testing the rate limiter by accident.
 */

const NAME = 'Websubmitted';

/**
 * Discard before delete, because the database refuses it the other way round.
 *
 * An `open` inquiry cannot be destroyed — that is a trigger, not application
 * code, so raw `psql` is bound by it exactly as the application is. Which makes
 * this fixture an assertion in its own right: the only way to remove what these
 * tests created is the same two-step the purge takes (D-03).
 */
const reset = () => {
  sql(`delete from "InquiryThrottle"`);
  sql(
    `update "Inquiry" set status = 'discarded', "discardReason" = 'spam', "discardedAt" = now()`
    + ` where "lastName" = '${NAME}' and status = 'open'`,
  );
  sql(`delete from "Inquiry" where "lastName" = '${NAME}'`);
  sql(`update "PracticeSettings" set "publicInquiryEnabled" = true, "publicInquiryPerHour" = 3 where id = 1`);
};

const submitted = () =>
  Number(sql(`select count(*) from "Inquiry" where "lastName" = '${NAME}'`));

test.beforeEach(() => reset());
test.afterAll(() => reset());

async function fillIn(page: import('@playwright/test').Page, first = 'Ada') {
  await page.getByLabel('First name').fill(first);
  await page.getByLabel('Last name').fill(NAME);
  await page.getByLabel('Email').fill(`${first.toLowerCase()}@example.test`);
}

test.describe('a stranger enquires', () => {
  test('sends a name and a way to be reached, and is thanked', async ({ page }) => {
    await page.goto('/enquire');
    await fillIn(page);
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('heading', { name: /Thank you/ })).toBeVisible();
    expect(submitted()).toBe(1);
  });

  test('has nowhere to describe why they are calling', async ({ page }) => {
    await page.goto('/enquire');
    // The design, asserted where somebody would actually add one back.
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.getByText(/do not write anything about your health/i)).toBeVisible();
  });

  test('says it is a demo, in both languages, before anything is typed', async ({ page }) => {
    await page.goto('/enquire');
    await expect(page.getByRole('note').filter({ hasText: /demo with invented people/i })).toBeVisible();
    await page.goto('/enquire?lang=es');
    await expect(page.getByRole('note').filter({ hasText: /demostración con personas inventadas/i })).toBeVisible();
  });

  test('reads the form in Spanish without a record to say so', async ({ page }) => {
    await page.goto('/enquire?lang=es');
    await expect(page.getByRole('heading', { name: 'Pregúntenos por una cita' })).toBeVisible();
    await expect(page.getByText(/no escriba nada sobre su salud/i)).toBeVisible();
  });

  test('is turned away once the hour is spent, and told to ring instead', async ({ page }) => {
    for (const who of ['Ada', 'Bea', 'Cass']) {
      await page.goto('/enquire');
      await fillIn(page, who);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByRole('heading', { name: /Thank you/ })).toBeVisible();
    }

    await page.goto('/enquire');
    await fillIn(page, 'Dee');
    await page.getByRole('button', { name: 'Send' }).click();

    // Scoped to the page: Next's route announcer is an `alert` too.
    await expect(page.locator('main [role="alert"]')).toContainText(/give us a little time, or call us/i);
    expect(submitted()).toBe(3);
  });

  test('meets a phone number rather than a dead page when the form is closed', async ({ page }) => {
    sql(`update "PracticeSettings" set "publicInquiryEnabled" = false where id = 1`);

    await page.goto('/enquire');
    await expect(page.getByText(/not taking enquiries through this form/i)).toBeVisible();
    await expect(page.getByText(/call us on/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
  });
});

/**
 * PRD 4: a refusal hands back what was typed, in the response body and never the
 * URL. Run with JavaScript on and off, because the public form is not allowed to
 * start needing it.
 */
for (const javaScriptEnabled of [true, false]) {
  test.describe(`a refused enquiry keeps what was typed (JavaScript ${javaScriptEnabled ? 'on' : 'off'})`, () => {
    test.use({ javaScriptEnabled });

    test('names without a way to reach them come back filled in, with the reason', async ({ page }) => {
      await page.goto('/enquire');
      await page.getByLabel('First name').fill('Ada');
      await page.getByLabel('Last name').fill(NAME);
      await page.getByLabel('Someone in particular?').selectOption({ index: 1 });
      const clinician = await page.getByLabel('Someone in particular?').inputValue();
      await page.getByRole('button', { name: 'Send' }).click();

      await expect(page.locator('main [role="alert"]')).toContainText(/either an email address or a phone number/i);
      await expect(page.getByLabel('First name')).toHaveValue('Ada');
      await expect(page.getByLabel('Last name')).toHaveValue(NAME);
      await expect(page.getByLabel('Someone in particular?')).toHaveValue(clinician);
      expect(page.url()).not.toContain('Ada');
      expect(page.url()).not.toContain(NAME);
      expect(submitted()).toBe(0);
    });
  });
}

test.describe('what the practice sees', () => {
  test('an enquiry nobody took, badged as such on the worklist', async ({ page }) => {
    await page.goto('/enquire');
    await fillIn(page);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: /Thank you/ })).toBeVisible();

    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries?status=open');

    const row = page.locator('main li').filter({ hasText: NAME }).first();
    await expect(row).toContainText('From the website');
    await expect(row).toContainText('open');
  });

  test('is attributed to the public in the audit trail, naming nobody', async ({ page }) => {
    await page.goto('/enquire');
    await fillIn(page);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: /Thank you/ })).toBeVisible();

    const [role, allowed, clientId] = sql(
      `select "actorRole", allowed, coalesce("clientId", 'none') from "AuditEvent"`
      + ` where "actorId" = 'public' order by at desc limit 1`,
    ).split('|');

    expect(role).toBe('public');
    expect(allowed).toBe('t');
    // Ids only, and there is not even a client to name.
    expect(clientId).toBe('none');
  });
});
