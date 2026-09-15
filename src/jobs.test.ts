import { readdirSync, readFileSync } from 'node:fs';
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

/**
 * The thread that produced this file's third runner: `nonresponse:run` existed
 * for weeks with no schedule and nothing said so. A door with no schedule
 * never runs, and a schedule with no door is an hourly 404 nobody reads.
 */
describe('cron wiring', () => {
  it('has a route for every schedule and a schedule for every route', () => {
    const { crons } = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const scheduled = crons.map((c: { path: string }) => c.path).sort();
    const routes = readdirSync('app/api/cron').map((d) => `/api/cron/${d}`).sort();
    expect(scheduled).toEqual(routes);
  });
});
