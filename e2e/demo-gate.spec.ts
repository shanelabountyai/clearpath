import { request as pwRequest } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * SEC-01, against the production build the sweep runs on. A bare `fetch` sends
 * no credentials, which is what a stranger's browser has — Playwright's own
 * request contexts pick up the config's `httpCredentials`, so they cannot play
 * the stranger.
 */
const baseURL = `http://localhost:${process.env.PORT ?? 3700}`;

test.describe('the demo gate', () => {
  test('challenges a stranger on every page, including the public form', async () => {
    for (const path of ['/', '/enquire', '/p/anything', '/f/anything']) {
      const res = await fetch(baseURL + path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('www-authenticate'), path).toContain('Basic');
    }
  });

  test('admits the right password and refuses a wrong one', async () => {
    const wrong = await pwRequest.newContext({
      baseURL,
      httpCredentials: { username: 'demo', password: 'not-the-password', send: 'always' },
    });
    expect((await wrong.get('/enquire')).status()).toBe(401);
    await wrong.dispose();

    const right = await pwRequest.newContext({
      baseURL,
      httpCredentials: { username: 'demo', password: process.env.DEMO_ACCESS_PASSWORD!, send: 'always' },
    });
    expect((await right.get('/enquire')).status()).toBe(200);
    await right.dispose();
  });

  test('leaves the cron routes to their bearer check, not a Basic challenge', async () => {
    for (const path of ['/api/cron/reminders', '/api/cron/purge', '/api/cron/nonresponse']) {
      const res = await fetch(baseURL + path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('www-authenticate'), path).toBeNull();
    }
  });
});
