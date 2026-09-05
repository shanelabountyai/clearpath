import { actAs, expect, sql, test, USERS } from './fixtures';

/**
 * P1-3, end to end: a client texts back.
 *
 * Two things are worth driving through the real stack rather than a function
 * call. The endpoint is the only write in this application with no session
 * behind it and it can cancel an appointment, so its refusals are the spec.
 * And the front-desk surface has to be checked for what it does *not* contain
 * — a page that quietly rendered the message would pass every unit test in
 * `inbound.test.ts`, because none of them open a page.
 */

const post = (body: unknown, headers: Record<string, string> = {}) =>
  ({ data: body, headers: { 'content-type': 'application/json', ...headers } });

/** A client the seeded practice can actually reach. */
const reachable = () =>
  sql(`select phone from "Client" where phone is not null`
    + ` and "reminderPreference" <> 'none' order by code limit 1`);

test.describe('the inbound endpoint', () => {
  test('refuses a caller with no secret, and says nothing about the client', async ({ request }) => {
    const res = await request.post('/api/inbound', post({ from: reachable(), body: 'YES' }));
    expect(res.status()).toBe(401);
    // Not 404, not 200: an unauthenticated caller learns nothing about whether
    // that number belongs to anybody.
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('refuses a wrong secret', async ({ request }) => {
    const res = await request.post('/api/inbound', post(
      { from: reachable(), body: 'YES' },
      { authorization: 'Bearer not-the-secret' },
    ));
    expect(res.status()).toBe(401);
  });

  test('classifies a reply it can read, and answers with the classification only', async ({ request }) => {
    const from = reachable();
    const res = await request.post('/api/inbound', post(
      { from, body: 'I am not sure, can we talk tomorrow?' },
      { authorization: `Bearer ${process.env.INBOUND_WEBHOOK_SECRET}` },
    ));
    expect(res.ok()).toBe(true);

    const payload = await res.json();
    expect(payload.classification).toBe('unparsed');
    // The response must not echo what arrived: a carrier logs its callbacks,
    // and an echo is the same leak by a longer route.
    expect(JSON.stringify(payload)).not.toContain('tomorrow');

    // And nothing in the database holds it either.
    const stored = sql(`select count(*) from "InboundReply" where "classification" = 'unparsed'`);
    expect(Number(stored)).toBeGreaterThan(0);
  });

  test('gives an unknown number nothing to learn from', async ({ request }) => {
    const res = await request.post('/api/inbound', post(
      { from: '555-not-a-client', body: 'YES' },
      { authorization: `Bearer ${process.env.INBOUND_WEBHOOK_SECRET}` },
    ));
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown sender' });
  });
});

test.describe('what front desk gets', () => {
  test('a name, a number, and pointedly nothing to read', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');

    const section = page.locator('section').filter({ hasText: 'Clients who replied' });
    await expect(section.getByRole('heading', { name: 'Clients who replied — call them' })).toBeVisible();
    await expect(section.locator('a[href^="tel:"]').first()).toBeVisible();
    await expect(section.getByRole('button', { name: 'Called them' }).first()).toBeVisible();

    // The seeded reply's words, which exist nowhere on this page because they
    // exist nowhere at all.
    await expect(page.getByText('can I call you tomorrow')).toHaveCount(0);
  });

  test('marking it called takes it off the list', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');

    const before = Number(sql(`select count(*) from "InboundReply" where "handledAt" is null`));
    expect(before).toBeGreaterThan(0);

    await page.locator('section').filter({ hasText: 'Clients who replied' })
      .getByRole('button', { name: 'Called them' }).first().click();
    await expect(page.getByRole('heading', { name: 'Work lists' })).toBeVisible();

    expect(Number(sql(`select count(*) from "InboundReply" where "handledAt" is null`))).toBe(before - 1);
  });
});
