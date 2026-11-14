import { expect, test } from './fixtures';

// SEC-05 (and the header half of SEC-04 / K6): checked on a production build, past the gate.
test.describe('security headers', () => {
  for (const path of ['/', '/enquire', '/p/x', '/f/x']) {
    test(`${path} is unframable and unsniffable`, async ({ request }) => {
      const h = (await request.get(path)).headers();
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['x-powered-by']).toBeUndefined();
      expect(h['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    });
  }

  // same-origin, not no-referrer, wherever a native form POST must work
  // without JavaScript (next.config.ts says why).
  for (const path of ['/', '/enquire', '/p/x']) {
    test(`${path} sends no Referer to another site`, async ({ request }) => {
      expect((await request.get(path)).headers()['referrer-policy']).toBe('same-origin');
    });
  }

  for (const path of ['/f/x', '/f/x/done']) {
    test(`${path} sends no Referer at all`, async ({ request }) => {
      expect((await request.get(path)).headers()['referrer-policy']).toBe('no-referrer');
    });
  }

  for (const path of ['/p/x', '/f/x', '/f/x/done']) {
    test(`${path} is never cached and never indexed`, async ({ request }) => {
      const h = (await request.get(path)).headers();
      expect(h['cache-control']).toContain('no-store');
      expect(h['x-robots-tag']).toBe('noindex, nofollow');
    });
  }

  test('staff pages are not marked noindex by the token-door rule', async ({ request }) => {
    expect((await request.get('/enquire')).headers()['x-robots-tag']).toBeUndefined();
  });
});
