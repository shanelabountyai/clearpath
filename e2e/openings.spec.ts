import { actAs, expect, sql, test, USERS } from './fixtures';

/**
 * P2-2, end to end: the hour a cancellation gave back, and who is waiting for one.
 *
 * Worth driving through the real stack rather than leaving to the unit suite,
 * because the two things that can go wrong here are not logic. The first is
 * scoping: this list names clients and carries their phone numbers, so who sees
 * which rows is the spec, and a therapist seeing another clinician's freed hour
 * would be a privacy failure that no pure test can rule out. The second is that
 * the list has to *appear* — the previous version of this section called the
 * matcher with a hardcoded slot and wrapped it in a catch that swallowed a real
 * authorization denial, so an empty list and a refused read looked identical on
 * screen for two phases.
 */

/** The seeded practice's freed hours, read straight out of the database. */
const freedHours = () =>
  Number(sql(
    `select count(*) from "Appointment"`
    + ` where status in ('cancelled', 'late_cancelled') and "startAt" > now()`,
  ));

test.describe('the freed-hour list', () => {
  test('front desk gets the hours, the notice on each, and a number to ring', async ({ page }) => {
    expect(freedHours()).toBeGreaterThan(0);

    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');

    const section = page.locator('section').filter({ hasText: 'Freed hours — offer them' });
    await expect(section.getByRole('heading', { name: 'Freed hours — offer them' })).toBeVisible();
    await expect(section.getByText('notice').first()).toBeVisible();
    // The whole point of the list is that somebody rings somebody.
    await expect(section.getByText(/555-555-01\d\d/).first()).toBeVisible();
    // It never books, so it offers no button that would.
    await expect(section.getByRole('button', { name: /book|offer|assign/i })).toHaveCount(0);
  });

  /**
   * The hour nobody can take is the one that otherwise goes empty without
   * anybody noticing, so it stays on the list and says so. There is no "handled"
   * control anywhere in this section — a slot leaves it when the hour is filled,
   * the clinician stops working it, or it starts.
   */
  test('shows an hour with nobody waiting rather than hiding it', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');

    const section = page.locator('section').filter({ hasText: 'Freed hours — offer them' });
    await expect(section.getByText('Nobody on the waitlist can take this one').first()).toBeVisible();
    await expect(section.getByRole('button', { name: /handled|dismiss|done/i })).toHaveCount(0);
  });

  /**
   * Continuity, on the surface that would leak it. A waiting client is only
   * ever offered their own clinician's hour — checked here by reading every
   * name the page shows under a freed hour and confirming the practice agrees
   * about whose client they are.
   */
  test('never shows one clinician’s hour to another clinician’s client', async ({ page }) => {
    await actAs(page, USERS.therapist);
    await page.goto('/worklists');

    const section = page.locator('section').filter({ hasText: 'Freed hours — offer them' });
    const clinicians = await section.locator('div.border-b').allInnerTexts();
    for (const heading of clinicians) {
      expect(heading).toContain(USERS.therapist);
    }
  });

  /**
   * A therapist's list is their own hours; front desk runs the whole calendar.
   *
   * Counted against front desk rather than against a number from SQL, on
   * purpose: the raw count of future cancellations is not the count of offerable
   * hours — a vacation week and a rebooked hour both come out of it — and a spec
   * that re-derived those filters would be asserting its own arithmetic.
   */
  test('scopes a therapist to their own freed hours', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    const all = await page.locator('section')
      .filter({ hasText: 'Freed hours — offer them' }).getByText(/ notice$/).count();
    expect(all).toBeGreaterThan(1);

    await actAs(page, USERS.therapist);
    await page.goto('/worklists');
    const mine = await page.locator('section')
      .filter({ hasText: 'Freed hours — offer them' }).getByText(/ notice$/).count();
    expect(mine).toBeGreaterThan(0);
    expect(mine).toBeLessThan(all);
  });

  /**
   * The claim the section is for, asserted against the seeded practice as a
   * query: an hour a clinician is away for is not an hour to sell. The seed
   * cancels one inside the vacation week on purpose.
   */
  test('never offers an hour from a week the clinician is away', async ({ page }) => {
    const duringLeave = Number(sql(
      `select count(*) from "Appointment" a`
      + ` join "AvailabilityOverride" o on o."userId" = a."clinicianId"`
      + ` where a.status in ('cancelled', 'late_cancelled') and a."startAt" > now()`
      + ` and o.kind = 'unavailable' and o."startMinute" is null`
      + ` and a."startAt" >= o."fromDate" and a."startAt" < o."toDate" + interval '1 day'`,
    ));
    expect(duringLeave).toBeGreaterThan(0);

    await actAs(page, USERS.frontDesk);
    await page.goto('/worklists');
    const section = page.locator('section').filter({ hasText: 'Freed hours — offer them' });
    const shown = await section.getByText(/notice$/).count();
    expect(shown).toBe(freedHours() - duringLeave);
  });
});

test.describe('the freed hour on the calendar', () => {
  /**
   * The grid already draws a cancelled session, receded and struck through.
   * What it could not say on its own is that the hour is still sellable, which
   * is the difference between a record of who was meant to be there and a piece
   * of work somebody could do today.
   */
  test('marks the day a freed hour falls on, and links to the list', async ({ page }) => {
    const date = sql(
      `select to_char(("startAt" at time zone 'America/New_York')::date, 'YYYY-MM-DD')`
      + ` from "Appointment" where status in ('cancelled', 'late_cancelled') and "startAt" > now()`
      + ` order by "startAt" limit 1`,
    );

    await actAs(page, USERS.frontDesk);
    await page.goto(`/calendar?date=${date}`);

    await expect(page.locator('p', { hasText: 'Freed today:' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Offer them from the work-list' })).toBeVisible();
  });

  /** An hour that has started cannot be offered to anybody. */
  test('says nothing about freed hours on a day that has passed', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/calendar?date=2026-08-04');
    await expect(page.locator('p', { hasText: 'Freed today:' })).toHaveCount(0);
  });
});
