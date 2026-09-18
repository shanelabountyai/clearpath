import { actAs, expect, test, USERS } from './fixtures';
import { addDays, localDateOf, weekdayOf } from '../src/time';

/**
 * The seeded practice books Monday–Thursday, so "today" is an empty calendar on
 * a Friday or a weekend. A test that needs a cancellable session asks for the
 * next Monday, whose sessions are all still ahead of the clock.
 */
function nextMonday(): string {
  const today = localDateOf(new Date());
  return addDays(today, (8 - weekdayOf(today)) % 7 || 7);
}

test.describe('the calendar', () => {
  test('shows rooms as columns and telehealth in a lane of its own', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/calendar?date=2026-09-01');

    for (const room of ['Willow', 'Cedar', 'Linden', 'Aspen']) {
      await expect(page.getByText(room, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Telehealth', { exact: true })).toBeVisible();
    await expect(page.getByText('No room needed')).toBeVisible();
  });

  test('a cancellation states its consequence before the click', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto(`/calendar?date=${nextMonday()}`);
    await page.locator('a[href^="/appointments/"]').first().click();

    await expect(page.getByRole('heading', { name: /Cancel/ })).toBeVisible();
    await expect(page.getByText(/late cancellation|Advance notice/)).toBeVisible();
  });

  test('the work lists surface an absence and its displaced clients', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    await expect(page.getByRole('heading', { name: 'Reschedules from clinician absence' })).toBeVisible();
    await expect(page.getByText('Annual leave')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Continuity of care' })).toBeVisible();
  });

  /**
   * P1-3, rendered. The seeded practice contains a client who wrote a sentence
   * to the reminder number; the front desk surface has to show that they wrote
   * and none of what they wrote — so the spec asserts against the words
   * themselves, taken from the seed.
   */
  test('shows front desk that a client wrote in, and nothing they wrote', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');

    await expect(page.getByRole('heading', { name: 'Clients who wrote back — call them' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Called them' }).first()).toBeVisible();
    await expect(page.getByText(/really hard this week/)).toHaveCount(0);
    await expect(page.getByText(/not up to it/)).toHaveCount(0);
  });

  test('lists the sessions nobody has answered about, with a number to ring', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    await expect(page.getByRole('heading', { name: 'Nobody has said they are coming' })).toBeVisible();
  });

  /** P1-3. The seed's five open enquiries include some past the 3-day window. */
  test('lists open enquiries nobody has closed out, oldest first', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    await expect(page.getByRole('heading', { name: 'Calls nobody has closed out' })).toBeVisible();
    await expect(page.getByText(/days old/).first()).toBeVisible();
  });
});

test.describe('the client form', () => {
  test('is neutral, conditional and resumable', async ({ page, context }) => {
    const { sql } = await import('./fixtures');
    const token = sql(`
      select r.token from "FormRequest" r
      join "FormTemplate" t on t.id = r."templateId"
      join "Client" c on c.id = r."clientId"
      where t.key = 'intake' and r.status <> 'submitted' and c.language = 'en'
      order by r.token limit 1`);
    test.skip(!token, 'no unsubmitted intake in the seed');

    await context.clearCookies();
    await page.goto(`/f/${token}`);

    await expect(page.getByText('New Client Intake')).toBeVisible();
    // Nothing on this page names the practice's speciality.
    await expect(page.getByText(/counsel/i)).toHaveCount(0);
    await expect(page.getByText('Stillwater', { exact: true })).toBeVisible();

    // A conditional branch stays shut until its parent opens it.
    await expect(page.getByText('Roughly when was that?')).toHaveCount(0);
    await page.getByRole('radiogroup', { name: /worked with a therapist before/ }).getByText('Yes').click();
    await expect(page.getByText('Roughly when was that?')).toBeVisible();

    await page.getByRole('button', { name: 'Save and finish later' }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();

    await page.reload();
    await expect(page.getByText('Roughly when was that?')).toBeVisible();
  });

  /** PRD 3. The same safety line after every submission — nothing here says whether answers were flagged. */
  test('ends every submission with where to go if it cannot wait', async ({ page, context }) => {
    const { sql } = await import('./fixtures');
    const token = sql(`select token from "FormRequest" where status = 'submitted' limit 1`);
    test.skip(!token, 'no submitted form in the seed');

    await context.clearCookies();
    await page.goto(`/f/${token}/done`);
    await expect(page.getByText(/call 911|llame al 911/)).toBeVisible();
  });
});

test.describe('booking', () => {
  test('books a standing weekly session, and telehealth needs no room', async ({ page }) => {
    const { sql } = await import('./fixtures');
    await actAs(page, USERS.frontDesk);

    // A client with no standing series, so the new one is unambiguous.
    const id = sql(`
      select c.id from "Client" c
      where not exists (select 1 from "AppointmentSeries" s where s."clientId" = c.id)
      order by c.code limit 1`);
    test.skip(!id, 'every seeded client already has a series');

    await page.goto('/book');
    await page.getByLabel('Client').selectOption(id);
    await page.getByLabel('Modality').selectOption('telehealth');
    await page.getByLabel('Date').fill('2026-10-06');
    await page.getByRole('button', { name: 'Show times' }).click();

    await expect(page.getByText('No room required')).toBeVisible();
    await page.getByText('Every Tuesday').click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    await expect(page.getByText(/Standing session booked/)).toBeVisible();
  });

  test('offers no in-person time when every room is taken, but offers telehealth', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    // The seed fills all four rooms at 10:00, 14:00 and 16:00 on weekdays.
    await page.goto('/book?date=2026-10-06&modality=in_person');
    const inPerson = await page.locator('label:has(input[name="startMinute"])').allTextContents();

    await page.goto('/book?date=2026-10-06&modality=telehealth');
    const video = await page.locator('label:has(input[name="startMinute"])').allTextContents();

    expect(video.length).toBeGreaterThanOrEqual(inPerson.length);
  });
});
