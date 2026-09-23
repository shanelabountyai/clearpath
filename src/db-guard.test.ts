import { describe, expect, it } from 'vitest';
import { isLocalDatabaseUrl } from './db-guard';

describe('isLocalDatabaseUrl', () => {
  it.each([
    'postgresql://u:p@localhost:5432/clearpath_test?connection_limit=10&pool_timeout=20',
    'postgresql://u@127.0.0.1/clearpath_dev',
    'postgresql://u@[::1]:5432/clearpath_dev',
    'postgresql:///clearpath_dev?host=/tmp',
  ])('allows %s', (url) => expect(isLocalDatabaseUrl(url)).toBe(true));

  it.each([
    'postgres://u:p@db.render.com/x',
    'postgres://u:p@203.0.113.7:5432/x',
    'postgres://u:p@ep-x.neon.tech/x',
    'postgres://u:p@localhost.evil.com/x',
    'not a url',
  ])('refuses %s', (url) => expect(isLocalDatabaseUrl(url)).toBe(false));
});
