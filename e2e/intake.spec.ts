import { actAs, expect, test, USERS } from './fixtures';

/**
 * Who may end a call, and who may only take one.
 *
 * The matrix says a clinician creates enquiries and does not discard them, and
 * `permissions.test.ts` already proves the rule. What this proves is the last
 * inch: that the page draws its controls from the same rule rather than from a
 * role check, so a clinician is never shown a Discard button that the server
 * would refuse. A drawn-but-refused control is the failure mode this whole
 * project is arguing against.
 */
test.describe('the intake desk', () => {
  const caller = () => `Caller${Date.now().toString().slice(-6)}`;

  test('a clinician records a call and cannot end one', async ({ page }) => {
    const last = caller();
    await actAs(page, USERS.therapist);
    await page.goto('/inquiries');

    await page.getByLabel('First name').fill('Sam');
    await page.getByLabel('Last name').fill(last);
    // Exact: the referral directory beside this form collects a practice
    // phone, and `getByLabel` matches on substring.
    await page.getByLabel('Phone', { exact: true }).fill('555-0100');
    await page.getByRole('button', { name: 'Record the call' }).click();

    const row = page.locator('li', { hasText: last });
    await expect(row).toBeVisible();
    await expect(row.getByText('open')).toBeVisible();

    // The two things a clinician is not: the person who ends a call, and the
    // person who turns one into a client record.
    await expect(row.getByRole('button', { name: 'Discard' })).toHaveCount(0);
    await expect(row.getByRole('link', { name: 'Convert to client' })).toHaveCount(0);
  });

  /**
   * P1-2. The warning arrives *after* the record, and says one thing: there is
   * a code worth looking at. No name, no clinician, no status — and the call is
   * on file either way, because a person on the phone is not made to wait.
   */
  test('a caller we may already know is flagged, by code and nothing else', async ({ page }) => {
    const last = caller();
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries');

    await page.getByLabel('First name').fill('Sam');
    await page.getByLabel('Last name').fill(last);
    // TC-001's number, straight out of the seed.
    await page.getByLabel('Phone', { exact: true }).fill('555-0101');
    await page.getByRole('button', { name: 'Record the call' }).click();

    await expect(page.getByText('We may already know this person')).toBeVisible();
    await expect(page.getByRole('link', { name: 'TC-001' })).toBeVisible();
    // Warned, never blocked: the call is recorded and can still be converted.
    const row = page.locator('li', { hasText: last });
    await expect(row.getByText('open')).toBeVisible();
    await expect(row.getByRole('link', { name: 'Convert to client' })).toBeVisible();
  });

  test('front desk ends one with a reason code, and it is a code', async ({ page }) => {
    const last = caller();
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries');

    await page.getByLabel('First name').fill('Alex');
    await page.getByLabel('Last name').fill(last);
    await page.getByRole('button', { name: 'Record the call' }).click();

    const row = page.locator('li', { hasText: last });
    await expect(row.getByRole('link', { name: 'Convert to client' })).toBeVisible();

    // No free-text box anywhere near this: the reason is chosen from a fixed
    // vocabulary, which is what makes "why do enquiries not convert" a
    // question the reports page can answer.
    await row.getByLabel('Why this enquiry ended').selectOption('no_capacity');
    await row.getByRole('button', { name: 'Discard' }).click();

    const ended = page.locator('li', { hasText: last });
    await expect(ended.getByText('discarded')).toBeVisible();
    await expect(ended.getByText('No capacity')).toBeVisible();
    // Terminal: there is no way back to a client from here.
    await expect(ended.getByRole('link', { name: 'Convert to client' })).toHaveCount(0);
  });

  /**
   * P1-4. The seed's oldest discarded call clears the 90-day retention
   * default; the rest do not — so the badge has to pick out that one row,
   * not just appear because the filter is on discarded.
   */
  test('flags the discarded calls the next purge would destroy, and only those', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries?status=discarded');

    const due = page.locator('li', { hasText: 'Enquiry D15' });
    await expect(due.getByText('Due in next purge')).toBeVisible();

    const notDue = page.locator('li', { hasText: 'Enquiry D01' });
    await expect(notDue.getByText('Due in next purge')).toHaveCount(0);
  });

  /**
   * P2. Assignment and capacity, and the fact that they are two hands.
   *
   * The unit tests prove the matrix. What this proves is that the two halves
   * meet correctly on one screen: front desk can put a call anywhere and reads
   * the signal while doing it, and the person the signal is about is the only
   * one who can change it.
   */
  test('front desk puts a call in a queue and reads capacity while doing it', async ({ page }) => {
    const last = caller();
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries');

    await page.getByLabel('First name').fill('Jo');
    await page.getByLabel('Last name').fill(last);
    await page.getByRole('button', { name: 'Record the call' }).click();

    const row = page.locator('li', { hasText: last });
    await expect(row.getByText('Nobody’s queue yet')).toBeVisible();

    // Rosa has closed her books in the seed, and the option says so before
    // the click rather than after it. Selected by the option's own value: the
    // label carries live counts, so matching on its text would be a spec that
    // fails the day somebody books a session.
    const picker = row.getByLabel('Whose queue this call goes in');
    const closed = picker.locator('option', { hasText: `${USERS.supervisor} — closed` });
    await expect(closed).toHaveCount(1);

    await picker.selectOption((await closed.getAttribute('value'))!);
    await row.getByRole('button', { name: 'Assign' }).click();

    // Assigned anyway — a signal, never a gate — and the warning stays on the
    // row afterwards, because a clinician can close their books at any point
    // after a call landed with them.
    const assigned = page.locator('li', { hasText: last });
    await expect(assigned.getByText(`In ${USERS.supervisor}’s queue`)).toBeVisible();
    await expect(assigned.getByText('not taking anybody new')).toBeVisible();
  });

  test('front desk reads the capacity board and cannot change anybody’s answer', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries');

    await expect(page.getByText('Who has room')).toBeVisible();
    await expect(page.getByRole('button', { name: /my books$/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Yours/ })).toHaveCount(0);
  });

  test('a clinician works their own queue and declares their own capacity', async ({ page }) => {
    await actAs(page, USERS.therapist);
    await page.goto('/inquiries');

    // Nour is open in the seed, and holds one seeded enquiry.
    const toggle = page.getByRole('button', { name: 'Close my books' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Open my books' })).toBeVisible();

    await page.getByRole('link', { name: /^Yours/ }).click();
    await expect(page).toHaveURL(/assigned=me/);
    // Every row on this filter is theirs, and it is a view rather than a
    // narrower permission — the unfiltered list still shows everybody's.
    const rows = page.locator('li', { hasText: 'Enquiry O' });
    await expect(rows.first().getByText(`In ${USERS.therapist}’s queue`)).toBeVisible();

    // Assignment is not theirs, even over a call sitting in their own queue.
    await expect(rows.first().getByRole('button', { name: 'Assign' })).toHaveCount(0);

    // Put it back, so the spec leaves the seeded practice as it found it.
    await page.goto('/inquiries');
    await page.getByRole('button', { name: 'Open my books' }).click();
    await expect(page.getByRole('button', { name: 'Close my books' })).toBeVisible();
  });

  /**
   * P2. The referral code becomes an entity.
   *
   * The unit tests prove the shaping and the database CHECK. What this proves
   * is the screen: a call recorded against a surgery says which surgery, and
   * the two halves of the `referrer` row — add, and curate — land on different
   * people exactly as the matrix says.
   */
  test('front desk records which surgery sent a caller, and it shows on the row', async ({ page }) => {
    const last = caller();
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries');

    await page.getByLabel('First name').fill('Ines');
    await page.getByLabel('Last name').fill(last);
    await page.getByLabel('How they found us').selectOption('gp');
    await page.getByLabel('Which practice (GP referrals only)')
      .selectOption({ label: 'Dr A. Patel, Riverside Surgery' });
    await page.getByRole('button', { name: 'Record the call' }).click();

    // "A GP" is the code; this is the thing a practice manager can ring.
    // The detail line, not the "Referred to" picker further down the same row.
    const row = page.locator('li', { hasText: last });
    await expect(row.locator('p', { hasText: 'Dr A. Patel, Riverside Surgery' })).toBeVisible();
  });

  test('a clinician may add a practice to the directory and may not retire one', async ({ page }) => {
    await actAs(page, USERS.therapist);
    await page.goto('/inquiries');

    await expect(page.getByText('Referring practices')).toBeVisible();
    // `referrer: create` — the same shape as `inquiry`: writing one down is
    // clerical, curating the list every future call reads is operations.
    await page.getByText('Add one').click();
    await expect(page.getByRole('button', { name: 'Add to the directory' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retire' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(0);
  });

  test('front desk retires a practice and it is still named by the calls that point at it', async ({ page }) => {
    await actAs(page, USERS.frontDesk);
    await page.goto('/inquiries');

    // Seeded already retired, and still on the list — the whole argument for
    // an `update` rather than a `delete`.
    const retired = page.locator('li', { hasText: 'Old Mill Surgery' });
    await expect(retired.getByRole('button', { name: 'Restore' })).toBeVisible();

    // And it is not offered on a new call, because it has closed its list.
    const picker = page.getByLabel('Which practice (GP referrals only)');
    await expect(picker.locator('option', { hasText: 'Old Mill Surgery' })).toHaveCount(0);
  });

  test('the practice manager reads the board and has no way to set a clinician open', async ({ page }) => {
    await actAs(page, USERS.manager);
    await page.goto('/inquiries');

    await expect(page.getByText('Who has room')).toBeVisible();
    // Assignment yes — where a call goes is operations. Capacity no: it is the
    // one cell on this page the practice manager is denied, and there is no
    // break-glass to reach it with.
    await expect(page.getByRole('button', { name: 'Assign' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /my books$/ })).toHaveCount(0);
  });
});
