import { test as base, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

/**
 * The specs act as people rather than as sessions: there is no login, so
 * "sign in" is setting the dev switcher cookie to a seeded user's id.
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

export async function actAs(page: Page, name: string) {
  await page.context().addCookies([
    { name: 'clearpath_user', value: userId(name), url: 'http://localhost:3700' },
  ]);
}

export const test = base;
export { expect } from '@playwright/test';

/**
 * PRD 5: a guarded button only opens a dialog, and the button inside it
 * submits. Both carry the same name, so the second is looked for in the dialog.
 */
export async function confirmClick(scope: Page | Locator, name: string) {
  await scope.getByRole('button', { name, exact: true }).click();
  await scope.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
