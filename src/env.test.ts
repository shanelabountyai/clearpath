import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_VARS, parseEnv } from './env';

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

/** A configuration that must always pass: only DATABASE_URL is required. */
const MINIMAL = { DATABASE_URL: 'postgresql://u@localhost:5432/clearpath_dev' };

describe('parseEnv', () => {
  it('accepts the minimum, and does not invent defaults for the optional ones', () => {
    const loaded = parseEnv(env(MINIMAL));
    expect(loaded.DATABASE_URL).toBe(MINIMAL.DATABASE_URL);
    expect(loaded.CRON_SECRET).toBeUndefined();
    expect(loaded.CLEARPATH_BASE_URL).toBeUndefined();
  });

  it('accepts the blank optionals a .env copied from .env.example carries', () => {
    // The whole point: `if (env.X)` reads these as unset, so the schema must
    // too. Rejecting them would make the documented starting point unbootable.
    const loaded = parseEnv(env({
      ...MINIMAL,
      CLEARPATH_THROTTLE_SECRET: '',
      DEMO_ACCESS_PASSWORD: '',
      CLEARPATH_SESSION_SECRET: '',
      CRON_SECRET: '',
      CLEARPATH_BASE_URL: '',
    }));
    expect(loaded.DEMO_ACCESS_PASSWORD).toBeUndefined();
    expect(loaded.CLEARPATH_BASE_URL).toBeUndefined();
  });

  it('names a missing required variable, and says it is not set', () => {
    expect(() => parseEnv(env({}))).toThrow(/DATABASE_URL is not set/);
  });

  it('names a malformed one, and does not call it unset', () => {
    expect(() => parseEnv(env({ DATABASE_URL: 'mysql://localhost/x' })))
      .toThrow(/DATABASE_URL must start with postgres/);
    expect(() => parseEnv(env({ DATABASE_URL: 'postgresql://u@localhost:99999/db' })))
      .toThrow(/DATABASE_URL is not a parseable URL/);
    // `postgresql:///db` is libpq's unix-socket form and db-guard allows it,
    // so an empty host must stay valid here rather than look malformed.
    expect(parseEnv(env({ DATABASE_URL: 'postgresql:///clearpath_dev' })).DATABASE_URL)
      .toBe('postgresql:///clearpath_dev');
  });

  it('rejects a secret pasted with a trailing newline', () => {
    // Length-checked constant-time compare: one invisible character is a
    // permanent 401 whose cause never appears in a log.
    expect(() => parseEnv(env({ ...MINIMAL, DEMO_ACCESS_PASSWORD: 'hunter2\n' })))
      .toThrow(/DEMO_ACCESS_PASSWORD has leading or trailing whitespace/);
    expect(() => parseEnv(env({ ...MINIMAL, CRON_SECRET: ' abc' })))
      .toThrow(/CRON_SECRET has leading or trailing whitespace/);
  });

  it('accepts CLEARPATH_BASE_URL in both shapes clientUrl accepts', () => {
    expect(parseEnv(env({ ...MINIMAL, CLEARPATH_BASE_URL: 'clinic.example.org' }))
      .CLEARPATH_BASE_URL).toBe('clinic.example.org');
    expect(parseEnv(env({ ...MINIMAL, CLEARPATH_BASE_URL: 'https://clinic.example.org/' }))
      .CLEARPATH_BASE_URL).toBe('https://clinic.example.org/');
  });

  it('reports every bad variable at once, so one restart fixes the deployment', () => {
    const boom = () => parseEnv(env({ DEMO_ACCESS_PASSWORD: 'x ', PORT: '0' }));
    expect(boom).toThrow(/DATABASE_URL/);
    expect(boom).toThrow(/DEMO_ACCESS_PASSWORD/);
    expect(boom).toThrow(/PORT/);
  });
});

/**
 * The schema is only worth having if it is complete, and the way it rots is a
 * new `process.env.SOMETHING` added to a route six months from now. Same shape
 * as the greps in `permissions.test.ts` and `notes/service.test.ts`: the rule
 * enforces itself rather than relying on anyone remembering it.
 */
it('covers every environment variable the application reads', () => {
  // Read by the harness and the design-system script, never by the app.
  const NOT_THE_APP = new Set(['CI', 'SHOTS', 'E2E_DEV', 'PGDATABASE', 'DS_COMPONENTS_OUT', 'NEXT_RUNTIME']);
  const owned = new Set<string>([...ENV_VARS, ...NOT_THE_APP]);
  const uncovered = new Set<string>();

  const scan = (path: string) => {
    for (const [, name] of readFileSync(path, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (name && !owned.has(name)) uncovered.add(`${path}: ${name}`);
    }
  };

  for (const entry of ['proxy.ts', 'instrumentation.ts']) scan(entry);
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      scan(path);
    }
  }

  expect([...uncovered]).toEqual([]);
});
