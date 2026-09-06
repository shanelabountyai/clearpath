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

  /**
   * A client the practice never messages has no cadence to choose — but the
   * channel that put them there is still editable, which it was not until this
   * phase. Hiding the whole form made `none` a one-way door.
   */
  test('hides the cadence for a client on no messages, and not the way back', async ({ page }) => {
    const code = sql(`select code from "Client" where "reminderPreference" = 'none' order by code limit 1`);
    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${clientId(code)}`);

    await expect(page.locator('dl').getByText('None — do not message')).toBeVisible();
    await expect(page.getByLabel('Confirmation messages')).toHaveCount(0);
    await expect(page.getByLabel('Channel')).toBeVisible();
  });

  /**
   * And submitting that form without a cadence still saves. The controls are
   * validated one at a time precisely so the submission that turns somebody's
   * messages back on — which cannot carry a cadence, because the select is not
   * on the page — is not dropped for missing one.
   */
  test('turns the messages back on from a form that has no cadence in it', async ({ page }) => {
    const code = sql(`select code from "Client" where "reminderPreference" = 'none' order by code limit 1`);
    const id = clientId(code);
    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${id}`);

    await page.getByLabel('Channel').selectOption('email');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    expect(sql(`select "reminderPreference" from "Client" where id = '${id}'`)).toBe('email');
    // And the cadence they had all along is untouched, not reset to a default.
    await expect(page.getByLabel('Confirmation messages')).toBeVisible();

    sql(`update "Client" set "reminderPreference" = 'none' where id = '${id}'`);
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

  /**
   * The third precondition, over the whole quarter and against the messages
   * rather than against the record.
   *
   * The record is the thing that changed: these clients were entered as English
   * readers, messaged in English, and corrected to Spanish afterwards. Reading
   * `Client.language` alone says they can be written to in Spanish and always
   * could; reading `OutboxMessage.language` says what was actually sent. Only
   * the second one can tell that nobody asked them anything they could read.
   */
  test('nobody is charged for a message written in a language they do not read', async () => {
    const unreadable = Number(sql(
      `select count(*) from "Appointment" a join "Client" c on c.id = a."clientId"`
      // `no_show` as well as `no_response`, which the two assertions above do
      // not need and this one does. They ask about a message that never arrived
      // or arrived too late, and both of those are settled before the hour: a
      // client the practice could not reach in time and who then walked in has
      // a delivered-in-time message on the row anyway. A language mismatch is
      // the one that appears *after* the fact, so it also lands on sessions the
      // client attended — and the charge on those is the session fee they came
      // and paid, which rests on attendance and not on anything anybody read.
      // The fee this policy produces is the no-show one.
      + ` where a.confirmation = 'no_response' and a.status = 'no_show'`
      + ` and a."chargeFeeCents" is not null`
      + ` and not exists (select 1 from "AppointmentReminder" r`
      + `   join "OutboxMessage" m on m.id = r."outboxMessageId"`
      + `   where r."appointmentId" = a.id and m."deliveryState" = 'delivered'`
      + `   and m.language = c.language)`,
    ));
    expect(unreadable).toBe(0);
  });

  /**
   * And the quarter contains the case, rather than passing the assertion above
   * by never producing one. A correction is the only way in: nothing is ever
   * sent in a language the client is not down as reading.
   */
  test('a corrected record leaves messages behind in the language it disowned', async ({ page }) => {
    const disowned = Number(sql(
      `select count(*) from "OutboxMessage" m join "Client" c on c.id = m."clientId"`
      + ` where m."deliveryState" = 'delivered' and m.language <> c.language`,
    ));
    expect(disowned).toBeGreaterThan(0);

    // The messages stay on the record. Deleting them would make the row
    // consistent and destroy the only proof of what the practice actually said.
    const stoodDown = Number(sql(
      `select count(*) from "AuditEvent" where reason = 'confirmation_unreadable'`,
    ));
    expect(stoodDown).toBeGreaterThan(0);

    await actAs(page, USERS.manager);
    await page.goto('/reports');
    await expect(page.getByText('Asked in another language', { exact: true })).toBeVisible();
    await expect(page.getByText(/reached in a language\s+they read/)).toBeVisible();
  });
});

/**
 * The channel, which is the setting the cadence control keeps being mistaken
 * for — and which, until this phase, no screen in the application could change.
 */
test.describe('the channel', () => {
  test('can be turned off, and turned back on again', async ({ page }) => {
    const code = sql(`select code from "Client" where "reminderPreference" = 'email'`
      + ` order by code limit 1`);
    const id = clientId(code);

    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${id}`);
    await page.getByLabel('Channel').selectOption('none');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.locator('dl').getByText('None — do not message')).toBeVisible();
    expect(sql(`select "reminderPreference" from "Client" where id = '${id}'`)).toBe('none');

    // The regression this spec exists for. The form used to render only for a
    // client who was *not* on `none`, so setting somebody to "no messages" —
    // by seed, by import, or by their own STOP — made it a one-way door that
    // no screen could open again. The client had to be edited in the database.
    await expect(page.getByLabel('Channel')).toBeVisible();
    await page.getByLabel('Channel').selectOption('sms');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(sql(`select "reminderPreference" from "Client" where id = '${id}'`)).toBe('sms');

    sql(`update "Client" set "reminderPreference" = 'email' where id = '${id}'`);
  });

  test('says what "none" costs the practice, where the choice is made', async ({ page }) => {
    const id = clientId(sql(`select code from "Client" order by code limit 1`));
    await actAs(page, USERS.frontDesk);
    await page.goto(`/clients/${id}`);

    // The consequence, beside the control rather than in a document: a client
    // on `none` is never asked, and so can never be charged for not answering.
    await expect(page.getByText(/safety setting, not a volume one/)).toBeVisible();
    await expect(page.getByText(/can never charge them for not answering/)).toBeVisible();
  });

  test('is not something a clinician can change for somebody else\'s client', async ({ page }) => {
    const otherCaseload = sql(
      `select c.code from "Client" c join "User" u on u.id = c."treatingClinicianId"`
      + ` where u.name <> '${USERS.therapist}' order by c.code limit 1`,
    );
    await actAs(page, USERS.therapist);
    await page.goto(`/clients/${clientId(otherCaseload)}`);
    await expect(page.getByLabel('Channel')).toHaveCount(0);
  });
});
