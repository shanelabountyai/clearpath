import { expect, test } from './fixtures';

// SEC-05 (and the header half of SEC-04): checked on a production build, past the gate.
test.describe('security headers', () => {
  for (const path of ['/', '/enquire', '/p/x', '/f/x']) {
    test(`${path} is unframable, unsniffable, referrer-free`, async ({ request }) => {
      const h = (await request.get(path)).headers();
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('same-origin');
      expect(h['x-powered-by']).toBeUndefined();
    });
  }

  for (const path of ['/p/x', '/f/x']) {
    test(`${path} is never cached`, async ({ request }) => {
      expect((await request.get(path)).headers()['cache-control']).toContain('no-store');
    });
  }
});
