import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { actAs, clientId, expect, sql, test, USERS, userId, confirmClick } from './fixtures';

/**
 * The seeded departure, executed (departure PRD, Success Metrics → Lagging).
 *
 * `departure.spec.ts` withdraws what it plans. This one does not: execution is
 * the point, and it cannot be undone. `test:e2e` reseeds before every sweep;
 * rerunning this file alone needs `npm run db:seed:e2e` first. The leaver is
 * the seed's Maren Solberg, whom no other spec signs in as.
 */
const LEAVER = 'Maren Solberg';
const PRIVATE = /Written before I left/;
// A note's link is its session date. "Book a session" ends the same way.
const NOTE = /^\d{4}-\d{2}-\d{2} session$/;
const refusal = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });
const leaver = () => userId(LEAVER);

async function openPlan(page: Page) {
  await actAs(page, USERS.manager);
  await page.goto('/departures');
  await page.getByRole('link', { name: LEAVER }).click();
  await expect(page.getByRole('heading', { name: `${LEAVER} is leaving` })).toBeVisible();
}

test.describe('a seeded departure, from the clash to the purge', () => {
  test.describe.configure({ mode: 'serial' });

  test('the planted clash refuses the whole departure, and nothing moves', async ({ page }) => {
    await openPlan(page);
    await expect(page.locator('li', { hasText: 'already holds' })).toContainText('Kai Oyelaran');

    await confirmClick(page, 'Execute departure');
    await expect(refusal(page, 'Nothing moved — not one client')).toBeVisible();

    // Eleven transfers were written before the clash. None of them survived it.
    expect(sql(`select count(*) from "Client" where "treatingClinicianId" = '${leaver()}' and status = 'active'`)).toBe('15');
    expect(sql(`select status from "Departure" where "userId" = '${leaver()}'`)).toBe('planned');
    expect(sql(`select active from "User" where id = '${leaver()}'`)).toBe('t');
    expect(sql(`select count(*) from "ProgressNote" where "authorId" = '${leaver()}' and status = 'abandoned'`)).toBe('0');
  });

  test('sending the clashing client to a free colleague lets the same plan execute', async ({ page }) => {
    await openPlan(page);
    const row = page.locator('li', { hasText: 'TC-081' });
    await row.getByLabel('Receiving clinician').selectOption(userId('Dev Marchetti'));
    await row.getByRole('button', { name: 'Change' }).click();
    await expect(page.getByText('Nothing in the way')).toBeVisible();

    await confirmClick(page, 'Execute departure');
    await expect(page.getByRole('heading', { name: 'Executed' })).toBeVisible();

    const m = leaver();
    expect(sql(`select string_agg(n, ',' order by n) from (select u.name || ' ' || count(*) n from "Client" c join "User" u on u.id = c."treatingClinicianId" where c.code between 'TC-071' and 'TC-085' and c.status = 'active' group by u.name) x`))
      .toBe('Dev Marchetti 5,Kai Oyelaran 3,Priya Vance 4');
    expect(sql(`select count(*) from "Client" where code between 'TC-071' and 'TC-085' and status = 'inactive'`)).toBe('3');
    // From the last day on. The weeks before it were hers to work.
    expect(sql(`select count(*) from "Appointment" a join "Departure" d on d."userId" = a."clinicianId" where a."clinicianId" = '${m}' and a."startAt" >= d."lastDayOn" and a.status in ('scheduled', 'confirmed')`)).toBe('0');
    expect(sql(`select count(*) from "ProgressNote" where "authorId" = '${m}' and status = 'abandoned'`)).toBe('4');
    expect(sql(`select count(*) from "ProcessNote" where "authorId" = '${m}' and "unreachableSince" is not null`)).toBe('3');
    // The two unread alerts went with their clients, one reader each (P0-7).
    expect(sql(`select string_agg(u.name, ',' order by u.name) from "Alert" a join "User" u on u.id = a."recipientId" join "Client" c on c.id = a."clientId" where c.code in ('TC-071', 'TC-075') and a."acknowledgedAt" is null`))
      .toBe('Dev Marchetti,Kai Oyelaran');
    expect(sql(`select active from "User" where id = '${m}'`)).toBe('f');
  });

  test('the receiver reads the whole record, and not a line of the private notes', async ({ page }) => {
    await actAs(page, 'Dev Marchetti');
    await page.goto(`/clients/${clientId('TC-071')}`);
    await expect(page.getByText(`Transferred from ${LEAVER} to Dev Marchetti`)).toBeVisible();
    await expect(page.getByRole('link', { name: NOTE })).toHaveCount(3);
    await page.getByRole('link', { name: NOTE }).first().click();
    await expect(page.getByText(/Presenting: steady/)).toBeVisible();
    await page.goBack();
    await expect(page.getByText(PRIVATE)).toHaveCount(0);
  });

  test('past the window the private notes are gone, and the audit trail is not', async () => {
    const m = leaver();
    const trail = sql(`select count(*) from "AuditEvent" where "actorId" = '${m}'`);

    // The real sweep, on a clock seven years and a day ahead. `purge:run` would
    // also sweep enquiries, which the specs after this one still read.
    const purged = execFileSync('node_modules/.bin/tsx', ['-e', `(async () => {
      const { runProcessNotePurge } = await import('./src/staff/departure.ts');
      const { DAY, fixedClock } = await import('./src/clock.ts');
      const { prisma } = await import('./src/db.ts');
      // A string, not a number: Playwright's FORCE_COLOR would wrap a logged number in ANSI codes.
      process.stdout.write(String((await runProcessNotePurge(fixedClock(new Date(Date.now() + 2556 * DAY)))).length));
      await prisma.$disconnect();
    })()`], { encoding: 'utf8' }).trim();

    expect(purged).toBe('3');
    expect(sql(`select count(*) from "ProcessNote" where "authorId" = '${m}'`)).toBe('0');
    expect(sql(`select count(*) from "NoteAmendment" where "authorId" = '${m}' and kind = 'process'`)).toBe('0');
    expect(sql(`select count(*) from "AuditEvent" where "actorId" = '${m}'`)).toBe(trail);
    expect(sql(`select count(*) from "AuditEvent" where reason = 'departure:process_note_destroyed'`)).toBe('3');
    // The official record is untouched by the sweep.
    expect(sql(`select count(*) from "ProgressNote" where "authorId" = '${m}'`)).toBe('45');
  });
});
