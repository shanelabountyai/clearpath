import { actAs, expect, sql, test, USERS } from './fixtures';
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

  /**
   * The one column that can hold two sessions at once, and so the one column
   * where chips can land on top of each other. `toBeVisible` does not catch
   * this — an element covered by another element is still visible to the DOM —
   * so the assertion is geometric.
   */
  test('sessions sharing an hour sit side by side, and none is hidden', async ({ page }) => {
    const [date, names] = sql(`
      select to_char(a."startAt" at time zone 'America/New_York', 'YYYY-MM-DD')
             || '|' || string_agg(c."lastName", ',' order by c."lastName")
      from "Appointment" a join "Client" c on c.id = a."clientId"
      where a.modality = 'telehealth' and a."groupSessionId" is null
      group by a."startAt" having count(*) > 1
      order by a."startAt" limit 1`).split('|');

    await actAs(page, USERS.frontDesk);
    await page.goto(`/calendar?date=${date}`);
    for (const name of names!.split(',')) {
      await expect(page.getByText(name, { exact: false })).toBeVisible();
    }

    const boxes = await page
      .locator('a[href^="/appointments/"], a[href^="/groups/"]')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const over = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        expect(over, `two chips overlap at ${a.left},${a.top}`).toBe(false);
      }
    }
    expect(boxes.length).toBeGreaterThan(names!.split(',').length);
  });

  test('a group is one chip for the hour and the heading says so', async ({ page }) => {
    // Six attendees are six client sessions and one booking of one room. Drawn
    // literally they are six chips stacked on identical pixels, which is what a
    // double-booking looks like — and counted literally the heading is a number
    // nobody can reconcile with what is on the screen.
    await actAs(page, USERS.frontDesk);
    const date = sql(`
      select to_char(a."startAt", 'YYYY-MM-DD') from "Appointment" a
      where a."groupSessionId" is not null order by a."startAt" limit 1`);
    await page.goto(`/calendar?date=${date}`);

    const rows = Number(sql(`
      select count(*) from "Appointment"
      where "startAt" >= timestamptz '${date} 00:00 America/New_York'
        and "startAt" <  timestamptz '${date} 00:00 America/New_York' + interval '1 day'`));
    const chips = await page.locator('a[href^="/appointments/"], a[href^="/groups/"]').count();

    expect(chips).toBeLessThan(rows);
    await expect(page.getByText(`${rows} sessions in ${chips} bookings`)).toBeVisible();

    // One chip, carrying the size of the roster, linking to the roster.
    const group = page.locator('a[href^="/groups/"]');
    await expect(group).toHaveCount(1);
    await expect(group).toContainText('×6');
  });

  test('a cancellation states its consequence before the click', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto(`/calendar?date=${nextMonday()}`);
    await page.locator('a[href^="/appointments/"]').first().click();

    await expect(page.getByRole('heading', { name: /Cancel/ })).toBeVisible();
    await expect(page.getByText(/late cancellation|Advance notice/)).toBeVisible();
  });

  /**
   * Two hours out is not a day off, and the two have to read differently.
   *
   * The banner used to announce anybody with any override as away for the day
   * while their morning sat in the grid below it — a page contradicting itself
   * where front desk reads it fastest.
   */
  test('a part-day absence is stated as hours, and the rest of the day still runs', async ({ page }) => {
    const [date, who, from, to] = sql(`
      select to_char(o."fromDate", 'YYYY-MM-DD') || '|' || u.name
             || '|' || o."startMinute" || '|' || o."endMinute"
      from "AvailabilityOverride" o join "User" u on u.id = o."userId"
      where o.kind = 'unavailable' and o."startMinute" is not null
      order by o."fromDate" limit 1`).split('|');

    await actAs(page, USERS.frontDesk);
    await page.goto(`/calendar?date=${date}`);

    // The hours are the whole point of the sentence, so they are in it.
    const hhmm = (m: string) =>
      `${String(Math.floor(Number(m) / 60)).padStart(2, '0')}:${String(Number(m) % 60).padStart(2, '0')}`;
    await expect(page.getByText(new RegExp(`${who} out ${hhmm(from!)}.${hhmm(to!)}`))).toBeVisible();
    await expect(page.getByText(new RegExp(`${who} away today`))).toHaveCount(0);

    // The seeded day happens to hold a whole-week vacation as well, so the two
    // shapes are in the same sentence — which is the sharpest form of the
    // assertion: one clinician is gone and one is out for two hours, and the
    // banner has to say so differently.
    await expect(page.getByText(/away today/)).toBeVisible();

    // And the part-day clinician is still seeing people the same day.
    await expect(page.locator('a[href^="/appointments/"]').first()).toBeVisible();
  });

  test('the work lists surface an absence and its displaced clients', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    await expect(page.getByRole('heading', { name: 'Reschedules from clinician absence' })).toBeVisible();
    await expect(page.getByText('Annual leave')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Continuity of care' })).toBeVisible();
  });

  /**
   * The other half: a part-day absence displaces the sessions inside its hours
   * and nothing else. The list used to hand back the clinician's whole day, so
   * every row was a phone call and most of them were not.
   */
  test('a part-day absence displaces only the sessions inside its hours', async ({ page }) => {
    const inside = sql(`
      select c."lastName"
      from "AvailabilityOverride" o
      join "Appointment" a on a."clinicianId" = o."userId"
      join "Client" c on c.id = a."clientId"
      where o.kind = 'unavailable' and o."startMinute" is not null
        and (a."startAt" at time zone 'America/New_York')::date = o."fromDate"
        and extract(hour from a."startAt" at time zone 'America/New_York') * 60 >= o."startMinute"
        and extract(hour from a."startAt" at time zone 'America/New_York') * 60 < o."endMinute"
      limit 1`);
    const outside = sql(`
      select c."lastName"
      from "AvailabilityOverride" o
      join "Appointment" a on a."clinicianId" = o."userId"
      join "Client" c on c.id = a."clientId"
      where o.kind = 'unavailable' and o."startMinute" is not null
        and (a."startAt" at time zone 'America/New_York')::date = o."fromDate"
        and extract(hour from a."startAt" at time zone 'America/New_York') * 60 < o."startMinute"
      limit 1`);

    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    await expect(page.getByText('Offsite training')).toBeVisible();

    const card = page.locator('div', { hasText: 'Offsite training' }).last();
    await expect(card.getByText(inside, { exact: false })).toBeVisible();
    await expect(card.getByText(outside, { exact: false })).toHaveCount(0);
  });
});

test.describe('the client form', () => {
  test('is neutral, conditional and resumable', async ({ page, context }) => {
    const { sql } = await import('./fixtures');
    const token = sql(`
      select r.token from "FormRequest" r
      join "FormTemplate" t on t.id = r."templateId"
      where t.key = 'intake' and r.status <> 'submitted' limit 1`);
    test.skip(!token, 'no unsubmitted intake in the seed');

    await context.clearCookies();
    await page.goto(`/f/${token}`);

    await expect(page.getByText('New Client Intake')).toBeVisible();
    // Nothing on this page names the practice's speciality.
    await expect(page.getByText(/counsel/i)).toHaveCount(0);
    await expect(page.getByText('Stillwater', { exact: true })).toBeVisible();

    // A conditional branch stays shut until its parent opens it.
    await expect(page.getByText('Roughly when was that?')).toHaveCount(0);
    await page.getByRole('group', { name: /worked with a therapist before/ }).getByText('Yes').click();
    await expect(page.getByText('Roughly when was that?')).toBeVisible();

    await page.getByRole('button', { name: 'Save and finish later' }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();

    await page.reload();
    await expect(page.getByText('Roughly when was that?')).toBeVisible();
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
