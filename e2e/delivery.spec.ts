import { actAs, expect, sql, test, USERS } from './fixtures';

/**
 * P2, end to end: the carrier's word on whether a message arrived.
 *
 * Worth driving through the real stack for two reasons, both about seams rather
 * than logic. `/api/delivery` is the second write endpoint with no session
 * behind it, and it decides whether a fee has its evidence — so its refusals
 * are the spec, and the fact that it has its **own** secret is part of the
 * spec. And the two surfaces this phase added have to be checked for what they
 * do and do not show: a work list that names people nobody is reaching, and a
 * report that puts the delivery rate next to the charge rate.
 */

const post = (body: unknown, headers: Record<string, string> = {}) =>
  ({ data: body, headers: { 'content-type': 'application/json', ...headers } });

const bearer = (secret?: string) => ({ authorization: `Bearer ${secret}` });

/** A message the seeded carrier accepted, so its reference is real. */
const acceptedRef = () =>
  sql(`select "providerRef" from "OutboxMessage"`
    + ` where "providerRef" is not null and "deliveryState" = 'delivered' order by "scheduledFor" limit 1`);

test.describe('the delivery endpoint', () => {
  test('refuses a caller with no secret', async ({ request }) => {
    const res = await request.post('/api/delivery', post({ providerRef: acceptedRef(), state: 'delivered' }));
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  /**
   * The reason the two endpoints do not share a key. `/api/inbound` can cancel
   * somebody's appointment; a provider reporting delivery receipts has no
   * business being able to do that, so its credential must not open that door.
   */
  test('does not accept the inbound endpoint\'s secret', async ({ request }) => {
    const res = await request.post('/api/delivery', post(
      { providerRef: acceptedRef(), state: 'delivered' },
      bearer(process.env.INBOUND_WEBHOOK_SECRET),
    ));
    expect(res.status()).toBe(401);
  });

  test('refuses a state it does not know, rather than storing it', async ({ request }) => {
    const res = await request.post('/api/delivery', post(
      { providerRef: acceptedRef(), state: 'probably_arrived' },
      bearer(process.env.DELIVERY_WEBHOOK_SECRET),
    ));
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown state' });
  });

  /**
   * A carrier's error string routinely quotes the message and the destination
   * back at you. Refusing an unknown code is what keeps both out of an
   * operational table nobody thought of as holding either.
   */
  test('refuses a failure code it does not know', async ({ request }) => {
    const res = await request.post('/api/delivery', post(
      { providerRef: acceptedRef(), state: 'failed', failureCode: 'Undelivered: no route to 555-555-0101' },
      bearer(process.env.DELIVERY_WEBHOOK_SECRET),
    ));
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown failure code' });
  });

  /**
   * Carriers replay callbacks after an outage. A 500 here would make the
   * provider retry a message this practice no longer has, forever.
   */
  test('takes a reference it never issued without complaining', async ({ request }) => {
    const res = await request.post('/api/delivery', post(
      { providerRef: 'sim_never_issued', state: 'delivered' },
      bearer(process.env.DELIVERY_WEBHOOK_SECRET),
    ));
    expect(res.status()).toBe(202);
    expect(await res.json()).toEqual({ matched: false });
  });

  test('records a receipt and says what it did with it', async ({ request }) => {
    const providerRef = acceptedRef();
    const before = Number(sql(`select count(*) from "DeliveryReceipt" where "providerRef" = '${providerRef}'`));

    const res = await request.post('/api/delivery', post(
      { providerRef, state: 'delivered', occurredAt: '2026-09-02T12:00:00.000Z' },
      bearer(process.env.DELIVERY_WEBHOOK_SECRET),
    ));
    expect(res.ok()).toBe(true);
    expect(await res.json()).toMatchObject({ matched: true, state: 'delivered' });

    const after = Number(sql(`select count(*) from "DeliveryReceipt" where "providerRef" = '${providerRef}'`));
    expect(after).toBe(before + 1);
  });

  /** Codes and timestamps. There is no column for anything else. */
  test('keeps no message content on a receipt', async ({ request }) => {
    const columns = sql(
      `select string_agg(column_name, ',') from information_schema.columns`
      + ` where table_name = 'DeliveryReceipt'`,
    );
    for (const forbidden of ['body', 'subject', 'destination', 'to', 'phone', 'email', 'error', 'message']) {
      expect(columns.split(',')).not.toContain(forbidden);
    }
  });
});

test.describe('what the practice sees', () => {
  /**
   * The list that exists because of what the delivery precondition does not do.
   * Once a fee needs a delivery receipt, a client with a dead number stops
   * being charged — correctly, and completely silently. Without this section
   * the practice would keep booking them, keep not reaching them, and find out
   * when they stopped coming.
   */
  test('front desk gets the clients nobody could reach, with the address that failed', async ({ page }) => {
    const unreachable = Number(sql(
      `select count(distinct "clientId") from "OutboxMessage"`
      + ` where "deliveryState" = 'failed' and "failureCode" <> 'expired' and "clientId" is not null`,
    ));
    expect(unreachable).toBeGreaterThan(0);

    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');

    const section = page.locator('section').filter({ hasText: 'Clients we cannot reach' });
    await expect(section.getByRole('heading', { name: 'Clients we cannot reach — check their details' })).toBeVisible();
    await expect(section.getByText('undelivered').first()).toBeVisible();
    // No message content on a front-desk screen, here as everywhere else.
    await expect(page.getByText('Please let us know if you are coming')).toHaveCount(0);
  });

  /**
   * The delivery rate belongs in the same glance as the charge rate, because it
   * is now the charge's precondition: a practice reading "we charged 33 people"
   * needs "and 23 reminders never arrived" without changing pages.
   */
  test('the manager gets the delivery rate beside the fee total', async ({ page }) => {
    await actAs(page, USERS.manager);
    await page.goto('/reports');

    await expect(page.getByRole('heading', { name: 'Reminders, as the carrier reported them' })).toBeVisible();
    await expect(page.getByText('Delivered', { exact: true })).toBeVisible();
    await expect(page.getByText('Undelivered', { exact: true })).toBeVisible();
    await expect(page.getByText('Awaiting receipt', { exact: true })).toBeVisible();
    await expect(page.getByText('A session is only charged for silence where a carrier confirmed')).toBeVisible();
  });

  /**
   * The claim the whole phase is for, asserted against the seeded quarter as a
   * query rather than as a sentence: sessions the practice asked about where
   * nothing it sent ever arrived, and not one of them charged.
   */
  test('nobody is charged for a message that never arrived', async () => {
    const askedButUnreached = Number(sql(
      `select count(*) from "Appointment" a`
      + ` where exists (select 1 from "AppointmentReminder" r where r."appointmentId" = a.id)`
      + ` and not exists (select 1 from "AppointmentReminder" r`
      + `   join "OutboxMessage" m on m.id = r."outboxMessageId"`
      + `   where r."appointmentId" = a.id and m."deliveryState" = 'delivered')`,
    ));
    expect(askedButUnreached).toBeGreaterThan(0);

    const chargedAnyway = Number(sql(
      `select count(*) from "Appointment" a`
      + ` where a.confirmation = 'no_response' and a.status = 'no_show'`
      + ` and not exists (select 1 from "AppointmentReminder" r`
      + `   join "OutboxMessage" m on m.id = r."outboxMessageId"`
      + `   where r."appointmentId" = a.id and m."deliveryState" = 'delivered')`,
    ));
    expect(chargedAnyway).toBe(0);
  });
});
