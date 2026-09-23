import { describe, expect, it } from 'vitest';
import { demoChallenge } from './demo-gate';

const PASSWORD = 'firebird-demo';
const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

describe('demoChallenge', () => {
  it('lets everything through when no password is set outside production', () => {
    expect(demoChallenge('/', null, undefined, false)).toBeNull();
    expect(demoChallenge('/enquire', null, '', false)).toBeNull();
  });

  it.each([undefined, ''])('fails closed in production when the password is %j', (password) => {
    const res = demoChallenge('/', null, password, true);
    expect(res?.status).toBe(503);
    expect(res?.headers['WWW-Authenticate']).toBeUndefined();
    // Even a request carrying credentials is refused: there is nothing to check them against.
    expect(demoChallenge('/', basic('demo', 'anything'), password, true)?.status).toBe(503);
  });

  it('challenges an unauthenticated request once a password is set', () => {
    const res = demoChallenge('/', null, PASSWORD, true);
    expect(res?.status).toBe(401);
    expect(res?.headers['WWW-Authenticate']).toContain('Basic');
  });

  it('never indexes or caches a refusal', () => {
    for (const res of [demoChallenge('/', null, PASSWORD, true), demoChallenge('/', null, undefined, true)]) {
      expect(res?.headers['X-Robots-Tag']).toBe('noindex, nofollow');
      expect(res?.headers['Cache-Control']).toBe('no-store');
    }
  });

  it('accepts the right password, whatever the username', () => {
    expect(demoChallenge('/', basic('demo', PASSWORD), PASSWORD, true)).toBeNull();
    expect(demoChallenge('/', basic('', PASSWORD), PASSWORD, true)).toBeNull();
  });

  it.each(['/', '/enquire', '/p/abc', '/f/abc', '/clients', '/api/cron', '/api/cronx/reminders'])(
    'gates %s',
    (path) => {
      expect(demoChallenge(path, null, PASSWORD, true)?.status).toBe(401);
    },
  );

  // Vercel Cron cannot send Basic; each route checks its own bearer.
  it.each(['/api/cron/reminders', '/api/cron/purge', '/api/cron/nonresponse'])(
    'leaves %s to its own bearer check, in every mode',
    (path) => {
      expect(demoChallenge(path, null, PASSWORD, true)).toBeNull();
      expect(demoChallenge(path, null, undefined, true)).toBeNull();
    },
  );

  it.each([
    ['the wrong password', basic('demo', 'wrong')],
    ['a password that is a prefix', basic('demo', PASSWORD.slice(0, -1))],
    ['a password with trailing space', basic('demo', `${PASSWORD} `)],
    ['no colon in the decoded pair', `Basic ${btoa(PASSWORD)}`],
    ['undecodable base64', 'Basic !!!not-base64!!!'],
    ['a bearer token carrying the password', `Bearer ${PASSWORD}`],
    ['an empty header', ''],
  ])('challenges %s', (_label, authorization) => {
    expect(demoChallenge('/', authorization, PASSWORD, true)?.status).toBe(401);
  });

  it('accepts a password containing a colon', () => {
    expect(demoChallenge('/', basic('demo', 'a:b:c'), 'a:b:c', true)).toBeNull();
  });
});
