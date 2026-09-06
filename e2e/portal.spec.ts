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

/**
 * P2. The reminder is translated and the page it points at is the other half of
 * the same sentence — a Spanish message linking to two English buttons is a
 * loop the client cannot complete, and the fee rests on them completing it.
 *
 * Driven through the real page rather than asserted on the copy object, because
 * a dictionary that is complete and a page that never reads it look identical
 * from the unit suite.
 */
test.describe('the door in the client\'s own language', () => {
  // The specs above answer the fixture's appointments, and two buttons only
  // exist while a question is open. Rebuilding it is cheaper and clearer than
  // reaching into their state.
  test.beforeAll(() => fixture('setup'));

  test('renders every control in Spanish, and none of it in English', async ({ page }) => {
    sql(`update "Client" set language = 'es' where id = '${CLIENT}'`);
    await page.goto(`/p/${TOKEN}`);

    await expect(page.getByRole('heading', { name: /^Hola / })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sí, allí estaré' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'No puedo asistir' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pedir un cambio' }).first()).toBeVisible();

    // The English versions of the same controls are gone, not merely
    // outnumbered: a half-translated page is the failure worth catching.
    await expect(page.getByRole('button', { name: 'Yes, I will be there' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'I cannot make it' })).toHaveCount(0);
    await expect(page.getByText('This link is personal to you')).toHaveCount(0);
    await expect(page.getByText('Este enlace es personal')).toBeVisible();

    // The weekday too — the one word on the page the client has to act on.
    await expect(page.locator('main')).not.toContainText(/Monday|Tuesday|Wednesday|Thursday|Friday/);
  });

  test('discloses the fee in Spanish before it applies', async ({ page }) => {
    sql(`update "Client" set language = 'es' where id = '${CLIENT}'`);
    await page.goto(`/p/${TOKEN}`);

    // The nearest appointment is two hours out, so declining it is chargeable.
    await page.locator('main li').first().getByRole('button', { name: 'No puedo asistir' }).click();

    await expect(page.getByText(/conlleva un cargo de \$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sí, cancelarla' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Mantener la cita' })).toBeVisible();
    // Nothing has been cancelled yet: the first tap is a question in both
    // languages, and the interstitial is where the amount is named.
    expect(sql(`select status from "Appointment" where id = '${NEAR}'`)).toBe('scheduled');

    sql(`update "Client" set language = 'en' where id = '${CLIENT}'`);
  });

  test('refuses a dead link in both languages, because it knows whose it was', async ({ page }) => {
    await page.goto('/p/not-a-real-token-at-all');
    await expect(page.getByText('This link is not valid')).toBeVisible();
    await expect(page.getByText('Este enlace no es válido')).toBeVisible();
  });
});

/**
 * The only control on this page that changes something about the client rather
 * than about one appointment. What it cannot reach is as much the spec as what
 * it can — a leaked link is the threat model, and "there is no channel control
 * here" is a claim about a page rather than about a function.
 */
test.describe('choosing how many reminders, from the door', () => {
  test.beforeAll(() => fixture('setup'));

  test('narrows the cadence and shows what it is set to', async ({ page }) => {
    await page.goto(`/p/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'How many reminders you get' })).toBeVisible();

    await page.getByLabel('How many reminders you get').selectOption('day_before');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText('Saved — that is how many')).toBeVisible();
    expect(sql(`select "reminderCadence" from "Client" where id = '${CLIENT}'`)).toBe('day_before');

    // Reloading shows the choice, which is what lets a client whose link was
    // forwarded see that somebody else changed it.
    await page.goto(`/p/${TOKEN}`);
    await expect(page.getByLabel('How many reminders you get')).toHaveValue('day_before');
  });

  test('offers no way to stop the messages, and says where that request goes', async ({ page }) => {
    await page.goto(`/p/${TOKEN}`);

    const options = await page.getByLabel('How many reminders you get').locator('option').allInnerTexts();
    expect(options).toHaveLength(3);
    for (const label of options) expect(label.toLowerCase()).not.toContain('none');
    // The channel is not on this page in any form.
    await expect(page.getByLabel('Channel')).toHaveCount(0);
    await expect(page.getByText(/To stop them entirely, or to change where they are sent, please call us/))
      .toBeVisible();
  });

  test('leaves the client on a channel and still fee-eligible', async ({ page }) => {
    await page.goto(`/p/${TOKEN}`);
    await page.getByLabel('How many reminders you get').selectOption('day_of');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved — that is how many')).toBeVisible();

    // Fewer messages is not fewer obligations, and the door cannot make it so.
    expect(sql(`select "reminderPreference" from "Client" where id = '${CLIENT}'`)).not.toBe('none');
  });

  test('is logged as the client, on their own row and nobody else\'s', async ({ page }) => {
    const before = Number(sql(
      `select count(*) from "AuditEvent" where resource = 'reminder_cadence'`
      + ` and "clientId" = '${CLIENT}' and "actorRole" = 'client'`,
    ));

    await page.goto(`/p/${TOKEN}`);
    await page.getByLabel('How many reminders you get').selectOption('full');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved — that is how many')).toBeVisible();

    expect(Number(sql(
      `select count(*) from "AuditEvent" where resource = 'reminder_cadence'`
      + ` and "clientId" = '${CLIENT}' and "actorRole" = 'client'`,
    ))).toBe(before + 1);
  });
});
