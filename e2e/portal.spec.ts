import { execFileSync } from 'node:child_process';
import { expect, sql, test } from './fixtures';
import { CLIENT, FAR, MID, NEAR, TOKEN } from './portal-fixture';

/**
 * The client's door, driven as a client drives it: no login, no session, one
 * link and two buttons.
 *
 * `portal-fixture.ts` builds the three appointments this spec needs — one two
 * hours out, two comfortably clear of the late-cancel window — because the one
 * thing being asserted is measured against wall time and the seeded quarter is
 * pinned to a fixed date.
 */

const fixture = (mode: 'setup' | 'teardown') =>
  execFileSync('npx', ['tsx', 'e2e/portal-fixture.ts', mode], { stdio: 'pipe' });

test.beforeAll(() => fixture('setup'));
test.afterAll(() => fixture('teardown'));

test.describe('the confirmation door', () => {
  /** Soonest first, as `openPortal` orders them: near, mid, far. */
  const nth = (page: import('@playwright/test').Page, i: number) => page.locator('main li').nth(i);

  /**
   * Counted as a delta, never as an absolute. The audit table is append-only
   * and the fixture reuses its ids, so rows from an earlier run of this spec
   * are still there — an absolute count would pass once and then drift.
   */
  const answersFor = (appointmentId: string) =>
    Number(sql(
      `select count(*) from "AuditEvent" where "clientId" = '${CLIENT}'`
      + ` and action = 'update' and "resourceId" = '${appointmentId}'`,
    ));

  test('a client confirms in one tap, and is not offered a second one', async ({ page }) => {
    const before = answersFor(FAR);

    await page.goto(`/p/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Hello Test' })).toBeVisible();

    await nth(page, 2).getByRole('button', { name: 'Yes, I will be there' }).click();
    await expect(page.getByText('we have you down for that one')).toBeVisible();
    await expect(nth(page, 2).getByText('You have confirmed this one.')).toBeVisible();

    expect(sql(`select confirmation from "Appointment" where id = '${FAR}'`)).toBe('confirmed');
    // A client saying yes is not front desk saying they arrived.
    expect(sql(`select status from "Appointment" where id = '${FAR}'`)).toBe('scheduled');

    // One answer, one audit row — and the door stops asking, so the client
    // cannot tap it a second time from here at all.
    expect(answersFor(FAR)).toBe(before + 1);
    await page.reload();
    await expect(nth(page, 2).getByRole('button', { name: 'Yes, I will be there' })).toHaveCount(0);
    expect(answersFor(FAR)).toBe(before + 1);
  });

  test('declining outside the window costs nothing and asks nothing', async ({ page }) => {
    await page.goto(`/p/${TOKEN}`);
    await nth(page, 1).getByRole('button', { name: 'I cannot make it' }).click();

    await expect(page.getByText('That is cancelled')).toBeVisible();
    await expect(page.getByText(/charged at/)).toHaveCount(0);
    expect(sql(`select status from "Appointment" where id = '${MID}'`)).toBe('cancelled');
    expect(sql(`select confirmation from "Appointment" where id = '${MID}'`)).toBe('declined');
    expect(sql(`select coalesce("chargeFeeCents"::text,'none') from "Appointment" where id = '${MID}'`)).toBe('none');
  });

  test('declining inside the window names the fee and needs a second tap', async ({ page }) => {
    await page.goto(`/p/${TOKEN}`);
    await nth(page, 0).getByRole('button', { name: 'I cannot make it' }).click();

    // The interstitial: the policy is something the client is told, in dollars,
    // before it applies — not something they discover afterwards.
    await expect(page.getByText('Cancelling within 24 hours of the appointment is charged at $90.00.')).toBeVisible();
    expect(sql(`select status from "Appointment" where id = '${NEAR}'`)).toBe('scheduled');

    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
    await expect(page.getByText('That is cancelled')).toBeVisible();
    expect(sql(`select status from "Appointment" where id = '${NEAR}'`)).toBe('late_cancelled');
    expect(sql(`select "chargeFeeCents" from "Appointment" where id = '${NEAR}'`)).toBe('9000');
  });

  test('there is nowhere on the door to type anything', async ({ page }) => {
    await page.goto(`/p/${TOKEN}`);
    // Two buttons and four reason codes. No text input, in either direction.
    await expect(page.locator('input[type="text"], textarea')).toHaveCount(0);
    await expect(page.getByText(/counsel|therap/i)).toHaveCount(0);
  });
});
