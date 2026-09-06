import { test as base, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { DEMO_PASSWORD } from '../src/auth/demo';
import { codeForStep, stepAt } from '../src/auth/totp';
import { TOTP_PERIOD_SECONDS } from '../src/auth/totp';

/**
 * The specs act as people, and now that means signing in as them.
 *
 * This used to set `clearpath_user` to a seeded user's id, because there was no
 * login to perform. `actAs` now drives the real sign-in screen — password, and
 * for the four roles that require one, a second factor computed from the same
 * TOTP implementation the server verifies with. So the suite proves the door
 * works roughly seventy times over, as a side effect of every spec that needs
 * somebody signed in.
 *
 * The resulting token is cached per person for the run. That is not a shortcut
 * around the login, it is the only correct thing to do: a code may be spent
 * once, so signing in twice as the same person inside one 30-second window
 * would be refused as a replay — by the defence `sessions.test.ts` asserts.
 * `workers: 1` and `fullyParallel: false` make one cache safe.
 */
export const USERS = {
  frontDesk: 'Marion Whitlock',
  therapist: 'Nour Abadi',
  associate: 'Priya Vance',
  supervisor: 'Rosa Iyer',
  manager: 'Elena Sarkis',
  auditor: 'Owen Delacroix',
} as const;

/**
 * The specs read the seeded practice straight out of the database rather than
 * hard-coding ids. `clearpath_e2e` is deliberately not the unit-test database:
 * that one is truncated between tests, and a sweep that shares it is decided by
 * whichever suite ran last.
 */
const query = (sql: string) =>
  execFileSync('psql', [process.env.PGDATABASE ?? 'clearpath_e2e', '-tAc', sql], { encoding: 'utf8' }).trim();

export const userId = (name: string) => query(`select id from "User" where name = '${name}'`);
export const clientId = (code: string) => query(`select id from "Client" where code = '${code}'`);
export const sql = query;

export const SESSION_COOKIE = 'clearpath_session';
const ORIGIN = 'http://localhost:3700';

/** One live session per person, for the length of the run. */
const tokens = new Map<string, string>();

/** The code an authenticator app would be showing for this account right now. */
export const currentCode = (secret: string) => codeForStep(secret, stepAt(new Date()));

/**
 * A code for this account that has not been spent yet.
 *
 * Needed because signing somebody in spends the step it used, and a spec that
 * wants to demonstrate a replay has to start from a code that is not already
 * one. `totpLastStep` is the exact answer to "which step did we just spend",
 * so this waits out the remainder of that window and no longer — at most
 * thirty seconds, once.
 */
export async function freshCode(page: Page, name: string): Promise<string> {
  const secret = query(`select "totpSecret" from "User" where name = '${name}'`);
  if (!secret) throw new Error(`${name} is not enrolled in a second factor`);
  const spent = Number(query(`select coalesce("totpLastStep", 0) from "User" where name = '${name}'`));

  while (stepAt(new Date()) <= spent) await page.waitForTimeout(1_000);
  return currentCode(secret);
}

export { TOTP_PERIOD_SECONDS };

/**
 * Sign in through the screens a person uses, and keep the token.
 *
 * Handles both second-factor paths, because the seed enrols nobody: the first
 * sign-in for a clinical role meets mandatory enrolment and reads the secret
 * off the page, and any later one meets the challenge and reads it from the
 * database. Front desk and auditor meet neither.
 *
 * The challenge path waits for an unspent step rather than using whatever code
 * is showing. That is not defensive padding — Playwright gives each spec file
 * its own module registry, so the cache below is per file, and two files
 * signing the same person in inside one thirty-second window would present a
 * code that person had already spent. The server refuses it, correctly, as a
 * replay. Waiting is the suite obeying the rule it asked for.
 */
async function signInThroughTheUi(page: Page, name: string): Promise<string> {
  const email = query(`select email from "User" where name = '${name}'`);

  await page.context().clearCookies();
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', DEMO_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  if (await page.locator('#code').count()) {
    const enrolling = await page.getByTestId('totp-secret').count();
    // Enrolling proves a brand-new secret, which has spent nothing yet.
    const code = enrolling
      ? currentCode(await page.getByTestId('totp-secret').innerText())
      : await freshCode(page, name);

    await page.fill('#code', code);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
  }

  const cookie = (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error(`sign-in did not produce a session for ${name}`);
  return cookie.value;
}

export async function actAs(page: Page, name: string) {
  let token = tokens.get(name);
  if (!token) {
    token = await signInThroughTheUi(page, name);
    tokens.set(name, token);
  }
  await page.context().clearCookies();
  await page.context().addCookies([{ name: SESSION_COOKIE, value: token, url: ORIGIN }]);
}

/**
 * A session of its own, deliberately not cached.
 *
 * For the specs that end a session on purpose. Signing out through `actAs`
 * would revoke the token every later spec is still holding, and the failure
 * would land somewhere else entirely — a cadence page redirecting to the login
 * screen three files later, with nothing to connect it back.
 */
export async function signInFresh(page: Page, name: string): Promise<string> {
  return signInThroughTheUi(page, name);
}

export const test = base;
export { expect } from '@playwright/test';
