import { actAs, expect, sql, test, USERS } from './fixtures';

/**
 * The staff side of the money, against the seeded quarter.
 *
 * The unit specs prove the policy; these prove somebody can see it and act on
 * it. Two things are worth driving through a browser rather than a function
 * call: that the reversal is reachable by exactly one role, and that the work
 * list a practice is meant to use *before* the fee exists has real rows in it.
 */

/** A fee the sweep applied on its own, which is the only kind worth waiving. */
const automaticFee = () =>
  sql(`select id from "Appointment" where confirmation = 'no_response'`
    + ` and status = 'no_show' and "chargeFeeCents" is not null`
    + ` and "feeWaivedAt" is null order by "startAt" desc limit 1`);

test.describe('the waiver', () => {
  test('is offered to the practice manager and to nobody else', async ({ page }) => {
    const id = automaticFee();
    expect(id).not.toBe('');

    await actAs(page, USERS.manager);
    await page.goto(`/appointments/${id}`);
    await expect(page.getByRole('heading', { name: 'Waive this fee' })).toBeVisible();

    // Front desk runs the calendar and takes the call about the charge, which
    // is exactly why the affordance is not theirs to draw.
    await actAs(page, USERS.frontDesk);
    await page.goto(`/appointments/${id}`);
    await expect(page.getByRole('heading', { name: 'Waive this fee' })).toHaveCount(0);
  });

  test('zeroes the charge, keeps the absence, and leaves the amount on the record', async ({ page }) => {
    const id = automaticFee();
    await actAs(page, USERS.manager);
    await page.goto(`/appointments/${id}`);

    await page.getByLabel('Reason').selectOption('client_disputed');
    await page.getByRole('button', { name: /^Waive / }).click();

    await expect(page.getByText('Waived', { exact: false }).first()).toBeVisible();
    // The client still did not turn up. Waiving is a decision about money, and
    // it is not allowed to become a decision about what happened.
    await expect(page.getByText('No show')).toBeVisible();
    await expect(page.getByText('No reply')).toBeVisible();

    const [fee, waived, reason] = sql(
      `select "chargeFeeCents" || '|' || ("feeWaivedAt" is not null) || '|' ||`
      + ` (select reason from "AuditEvent" where "resourceId" = '${id}' and action = 'waive' limit 1)`
      + ` from "Appointment" where id = '${id}'`,
    ).split('|');
    expect(fee).toBe('0');
    expect(waived).toBe('true');
    // What was charged survives the reversal, which is the difference between
    // undoing a charge and pretending it never happened.
    expect(reason).toContain('client_disputed');
    expect(reason).toMatch(/\d+ cents/);
  });
});

test.describe('the work list a practice should use before the fee does', () => {
  test('lists unconfirmed sessions with a number to ring', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');

    const section = page.locator('section').filter({ hasText: 'Unconfirmed, starting soon' });
    await expect(section.getByRole('heading', { name: 'Unconfirmed, starting soon' })).toBeVisible();
    // The number is the feature: the list exists so somebody phones them.
    await expect(section.locator('a[href^="tel:"]').first()).toBeVisible();
  });

  test('is scheduling work, and so is denied to a clinical role', async ({ page }) => {
    await actAs(page, USERS.auditor);
    await page.goto('/worklists');
    await expect(page.getByText(/not permitted|Front-desk work lists/i).first()).toBeVisible();
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  });
});
