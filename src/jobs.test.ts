import { describe, expect, it } from 'vitest';
import { cronAuthorized } from './jobs';

describe('cronAuthorized', () => {
  it('accepts exactly the bearer Vercel Cron sends', () => {
    expect(cronAuthorized('Bearer s3cret', 's3cret')).toBe(true);
  });

  it.each([
    ['no header', null],
    ['empty header', ''],
    ['wrong secret', 'Bearer nope'],
    ['bare secret without the scheme', 's3cret'],
    ['secret as a prefix', 'Bearer s3cret-and-more'],
    ['lowercase scheme', 'bearer s3cret'],
  ])('refuses %s', (_, header) => {
    expect(cronAuthorized(header, 's3cret')).toBe(false);
  });

  it.each([undefined, ''])('fails closed when the secret is %j', (secret) => {
    expect(cronAuthorized('Bearer undefined', secret)).toBe(false);
    expect(cronAuthorized('Bearer ', secret)).toBe(false);
  });
});
