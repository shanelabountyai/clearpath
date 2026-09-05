import { actAs, clientId, expect, sql, test, USERS } from './fixtures';

/**
 * P2-3, end to end: the cadence a client asked for.
 *
 * Two things here are worth the real stack. The control is the first editable
 * client field in this app that changes what gets *sent* to somebody, so who
 * may touch it is the spec. And the copy beside it is load-bearing rather than
 * decorative: the one mistake a person at a desk can make with this control is
 * to reach for it when a client says "stop texting me", which is a different
 * setting with a different consequence for the fee — so the screen has to say
 * so where the choice is made, not in a document nobody opens.
 */

/** A seeded client who chose the day-of nudge alone. */
const dayOfClient = () =>
  sql(`select code from "Client" where "reminderCadence" = 'day_of' order by code limit 1`);

test.describe('choosing a cadence', () => {
  test('front desk can set it, and the record says what was chosen', async ({ page }) => {
    const code = sql(`select code from "Client" where "reminderCadence" = 'full'`
      + ` and "reminderPreference" <> 'none' order by code limit 1`);
    const id = clientId(code);

    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${id}`);
    // Scoped to the summary list: the same words are also the selected option
    // in the control below, which is the point — the record and the picker
    // agree — but it makes an unscoped locator ambiguous.
    await expect(page.locator('dl').getByText('Five days, the day before, and the day of')).toBeVisible();

    await page.getByLabel('Confirmation messages').selectOption('day_of');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.locator('dl').getByText('The day of, only')).toBeVisible();
    expect(sql(`select "reminderCadence" from "Client" where id = '${id}'`)).toBe('day_of');
  });

  /**
   * The copy that stops the control being used as an opt-out. A client asking
   * for fewer messages and a client asking for none are different requests with
   * different consequences, and only one of them ends the fee.
   */
  test('says plainly that fewer messages is not fewer obligations', async ({ page }) => {
    const id = clientId(dayOfClient());
    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${id}`);

    await expect(page.getByText(/can still be charged for the silence/)).toBeVisible();
    await expect(page.getByText(/change the channel to/)).toBeVisible();
  });

  /**
   * There is no cadence meaning "no messages". That is the channel setting, it
   * carries an exemption from the fee, and a second way to spell it would be a
   * second way to reach that exemption from a control that reads like a taste
   * in messages.
   */
  test('offers no option meaning "none"', async ({ page }) => {
    const id = clientId(dayOfClient());
    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${id}`);

    const options = await page.getByLabel('Confirmation messages').locator('option').allInnerTexts();
    expect(options).toHaveLength(3);
    for (const label of options) expect(label.toLowerCase()).not.toContain('none');
  });

  /** A client the practice never messages has no cadence to choose. */
  test('hides the control for a client on no messages at all', async ({ page }) => {
    const code = sql(`select code from "Client" where "reminderPreference" = 'none' order by code limit 1`);
    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${clientId(code)}`);

    await expect(page.getByText('None — do not message')).toBeVisible();
    await expect(page.getByLabel('Confirmation messages')).toHaveCount(0);
  });

  /** An auditor reads the log, never the record. */
  test('is not offered to a role that may not edit the record', async ({ page }) => {
    const id = clientId(dayOfClient());
    await actAs(page, USERS.auditor);
    await page.goto(`/clients/${id}`);
    await expect(page.getByLabel('Confirmation messages')).toHaveCount(0);
  });
});

test.describe('what the cadence costs and does not cost', () => {
  /**
   * The claim with money on it, asserted against the seeded quarter as a query.
   * A lighter cadence is fewer messages and not fewer obligations: clients who
   * chose one are still charged for silence, because one delivered message is
   * still asking. If this ever returns zero, the setting has quietly become an
   * opt-out from the policy.
   */
  test('a lighter cadence is still charged for silence', async () => {
    const charged = Number(sql(
      `select count(*) from "Appointment" a join "Client" c on c.id = a."clientId"`
      + ` where c."reminderCadence" <> 'full' and a.confirmation = 'no_response'`
      + ` and a."chargeFeeCents" is not null`,
    ));
    expect(charged).toBeGreaterThan(0);
  });

  /**
   * And the other half. Nobody is charged for not answering a message that
   * arrived with an hour to spare — the practice reached them, but not in time
   * for reaching them to mean anything.
   */
  test('nobody is charged for a message that arrived too late to answer', async () => {
    const window = Number(sql(`select "answerWindowMinutes" from "PracticeSettings" where id = 1`));
    expect(window).toBeGreaterThan(0);

    const tooLate = Number(sql(
      `select count(*) from "Appointment" a`
      + ` where a.confirmation = 'no_response' and a."chargeFeeCents" is not null`
      + ` and not exists (select 1 from "AppointmentReminder" r`
      + `   join "OutboxMessage" m on m.id = r."outboxMessageId"`
      + `   where r."appointmentId" = a.id and m."deliveredAt" is not null`
      + `   and m."deliveredAt" <= a."startAt" - (${window} * interval '1 minute'))`,
    ));
    expect(tooLate).toBe(0);
  });

  /** And the practice can see it standing down, beside the money it collected. */
  test('the manager sees how often it stood down for arriving late', async ({ page }) => {
    const stoodDown = Number(sql(
      `select count(*) from "AuditEvent" where reason = 'confirmation_unanswerable'`,
    ));
    expect(stoodDown).toBeGreaterThan(0);

    await actAs(page, USERS.manager);
    await page.goto('/reports');
    await expect(page.getByText('Reached too late', { exact: true })).toBeVisible();
    await expect(page.getByText(/reached with time to answer/)).toBeVisible();
  });
});
