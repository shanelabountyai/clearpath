import { execFileSync } from 'node:child_process';
import { actAs, clientId, expect, sql, test, USERS } from './fixtures';
import { ES_TOKEN } from './portal-fixture';

/**
 * Not an assertion — the README's pictures, captured from the same seeded
 * practice the specs run against, so they cannot drift from the product
 * without a rebuild. `npm run shots`; skipped in the ordinary sweep.
 *
 * The run co-signs a real note, which is why it re-seeds first: the pictures
 * are of the story actually happening, not of a pose.
 */
test.describe('README screenshots', () => {
  test.skip(!process.env.SHOTS, 'capture only');

  const shot = 'docs/screenshots';

  test('capture', async ({ page, baseURL }) => {
    const demoClient = clientId('TC-006');

    // The operational tier: front desk runs the whole calendar and learns
    // nothing about why anyone is in the building.
    await actAs(page, USERS.frontDesk);
    // The busiest seeded weekday, so the picture shows a working practice
    // rather than whatever today happens to hold.
    const busiest = sql(
      `select to_char("startAt", 'YYYY-MM-DD') from "Appointment" group by 1 order by count(*) desc, 1 limit 1`,
    );
    await page.goto(`/calendar?date=${busiest}`);
    await expect(page.getByText(/[1-9]\d* sessions ·/)).toBeVisible();
    await page.screenshot({ path: `${shot}/calendar-front-desk.png` });

    // The pair the design brief calls the portfolio shot: one client record,
    // two people. Front desk first — the same URL, and no clinical section on
    // it at all.
    await page.goto(`/clients/${demoClient}`);
    await expect(page.getByRole('heading', { name: 'Forms' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Progress notes' })).toHaveCount(0);
    await page.screenshot({ path: `${shot}/client-record-front-desk.png`, fullPage: true });

    // ── the storyboard, in order ──────────────────────────────────────────

    // 1. The associate signs a progress note. The seed leaves this one in
    //    draft precisely so the signing happens on camera.
    await actAs(page, USERS.associate);
    const draft = sql(
      `select n.id from "ProgressNote" n
         join "Client" c on c.id = n."clientId"
        where c.code = 'TC-006' and n.status = 'draft'
        limit 1`,
    );
    expect(draft, 'the seed must leave the demo client one draft note').toBeTruthy();
    await page.goto(`/notes/${draft}`);
    await expect(page.getByRole('button', { name: 'Sign' })).toBeVisible();
    await page.screenshot({ path: `${shot}/note-draft-signing.png` });

    // The same clinician, same client, seen by the person allowed everything:
    // the clinician view of the record the front desk just saw.
    await page.goto(`/clients/${demoClient}`);
    await expect(page.getByRole('heading', { name: 'Progress notes' })).toBeVisible();
    await page.screenshot({ path: `${shot}/client-record-clinician.png`, fullPage: true });

    await page.goto(`/notes/${draft}`);
    await page.getByRole('button', { name: 'Sign' }).click();
    await expect(page.getByText('Pending co-signature')).toBeVisible();

    // 2. It lands in the supervisor's queue — including the note just signed.
    await actAs(page, USERS.supervisor);
    await page.goto('/cosign');
    await expect(page.getByRole('heading', { name: 'Co-signature queue' })).toBeVisible();
    // By the note's own link, not by client name — the seeded queue already
    // holds another of this client's notes, and `.first()` picks whichever the
    // ageing order puts on top.
    const row = page.locator('li').filter({ has: page.locator(`a[href="/notes/${draft}"]`) });
    await expect(row).toBeVisible();
    await page.screenshot({ path: `${shot}/cosign-queue.png` });

    // 3. The supervisor co-signs it.
    await row.getByRole('button', { name: 'Co-sign' }).click();
    await expect(page).toHaveURL(/\/cosign/);
    await expect(row).toHaveCount(0);
    await page.goto(`/notes/${draft}`);
    await expect(page.getByText('Co-signed')).toBeVisible();
    await page.screenshot({ path: `${shot}/note-cosigned.png` });

    // 4. The rule, stated where the notes would be, to the supervisor of the
    //    clinician who wrote them.
    await page.goto(`/clients/${demoClient}`);
    // By role and name — the panel's title names the clinician, so there is no
    // fixed string to select on.
    const locked = page.getByRole('region', { name: /^Process notes by / });
    await expect(locked).toBeVisible();
    await locked.screenshot({ path: `${shot}/process-notes-locked.png` });

    // Reaching for the note directly is the refusal that frame 5 has to show.
    // Done here, last of the supervisor's actions, so it is the newest row in
    // the log and lands in frame beside the co-signature rather than below it.
    const processNote = sql(
      `select n.id from "ProcessNote" n
         join "Client" c on c.id = n."clientId"
        where c.code = 'TC-006' limit 1`,
    );
    await page.goto(`/process-notes/${processNote}`);
    await expect(page.getByText('This process note is not yours')).toBeVisible();

    // Administration reaches a clinical record only through a logged door.
    await actAs(page, USERS.manager);
    await page.goto(`/clients/${demoClient}`);
    await expect(page.getByRole('heading', { name: 'Break-glass access required' })).toBeVisible();
    await page.screenshot({ path: `${shot}/break-glass.png` });

    // 5. And the auditor sees the refusal without seeing what was refused.
    await actAs(page, USERS.auditor);
    await page.goto('/audit?denied=1&resource=process_note');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    // Every other pixel here is deterministic — the seed is date-pinned. The
    // audit row's stamp is not, because `at` defaults to the database clock
    // rather than the app's, which is the one timestamp the app should not get
    // to choose. Masked, so a diff on this picture means the product moved.
    await page.screenshot({
      path: `${shot}/audit-log.png`,
      mask: [page.locator('tbody td:first-child')],
      maskColor: '#a8a29a',
    });

    // The whole of frame 5 in one frame: this client's log, unfiltered, so the
    // co-signature that was allowed and the process-note read that was refused
    // sit in the same table. There is no `action` filter — the point is that
    // one log carries both, not that either can be isolated.
    await page.goto(`/audit?clientId=${demoClient}`);
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByText('allowed').first()).toBeVisible();
    await expect(page.getByText('denied').first()).toBeVisible();
    await page.screenshot({
      path: `${shot}/audit-log-both.png`,
      mask: [page.locator('tbody td:first-child')],
      maskColor: '#a8a29a',
    });

    // Coverage, from the other end: the supervisor whose leave ended yesterday,
    // and the four things he is owed — a screener that crossed while he was
    // gone, the session and note his coverer made of it, and the
    // countersignature somebody else gave his supervisee. The coverer's own
    // process notes are the thing that is not here.
    await actAs(page, 'Anders Fiske');
    await page.goto('/worklists');
    const away = page.locator('section', { has: page.getByRole('heading', { name: 'While you were away' }) });
    await expect(away.locator('li', { hasText: 'flagged for review' })).toContainText('TC-089');
    await expect(away.locator('li', { hasText: 'countersigned' })).toContainText('TC-090');
    await away.screenshot({ path: `${shot}/while-you-were-away.png` });

    // D-26: a clinician leaves under a supervisor who is away. Elin's one
    // client was discharged, not transferred, so the alert had nowhere to go
    // but her supervisor, Rosa — and Rosa is away, with Dev covering her
    // supervision. The picture is that alert sitting in Dev's inbox, not
    // Rosa's or the closed account's.
    await actAs(page, 'Dev Marchetti');
    await page.goto('/alerts');
    const routed = page.locator('li').filter({ has: page.getByText('TC-091', { exact: true }) });
    await expect(routed).toBeVisible();
    await routed.screenshot({ path: `${shot}/alert-routed-after-departure.png` });

    // ── the client's own tier ─────────────────────────────────────────────
    //
    // Every picture above is of a staff screen, and the access table they
    // argue has no row for the person the record is about. These two are the
    // only surfaces reached from outside the building: no login, one link, a
    // phone. Captured at 390 because that is the device they are opened on,
    // and the discretion rule is a layout property — a shoulder at that width
    // reads the whole screen.
    //
    // Their own context, not this page resized. Two reasons, and the second
    // one already bit: a fresh context holds no `clearpath_user` cookie, so
    // the picture is literally what a stranger with the link gets rather than
    // an argument that the cookie is unread — and resizing `page` changed the
    // width of the `fullPage` /design capture below, which is taken after
    // these and at whatever viewport was left behind.
    // `baseURL` is passed through by hand: a context built here, rather than
    // by the `page` fixture, inherits nothing from the config's `use`.
    const phone = await page.context().browser()!.newContext({
      viewport: { width: 390, height: 844 }, baseURL,
    });
    const client = await phone.newPage();

    // Consent, outstanding. The form the seed deliberately leaves unsubmitted
    // for six clients, so the banner has something to show and this page has
    // something to render. It names the practice and the form and nobody else:
    // no client name, no clinician name, and no word for what kind of practice
    // sent it. The typed-name signature is the last field.
    const consent = sql(
      `select r.token from "FormRequest" r
         join "FormTemplate" t on t.id = r."templateId"
        where t.key = 'consent-to-treat' and r."submittedAt" is null
        order by r.token limit 1`,
    );
    expect(consent, 'the seed must leave a consent form outstanding').toBeTruthy();
    await client.goto(`/f/${consent}`);
    await expect(client.getByRole('heading', { name: 'Consent to Treatment' })).toBeVisible();
    await expect(client.getByLabel(/Type your full name to sign/)).toBeVisible();
    await client.screenshot({ path: `${shot}/consent-form-client.png`, fullPage: true });

    // The consequence, before the action, in the language the client is
    // written in. The only picture here that needs rows the seed cannot hold:
    // whether a decline is inside the 24-hour window is measured against wall
    // time, and the seeded quarter is date-pinned, so no seeded appointment is
    // reliably four hours out on the day the camera runs. The portal spec's
    // fixture builds one — reused rather than rewritten, so there is one
    // definition of "inside the window" and not two. `setup` clears its own
    // rows first and `npm run shots` re-seeds over them, so there is nothing
    // to tear down; it runs last so no picture above can pick up its clients.
    execFileSync('npx', ['tsx', 'e2e/portal-fixture.ts', 'setup'], { stdio: 'pipe' });
    await client.goto(`/p/${ES_TOKEN}`);
    await client.getByRole('button', { name: 'No puedo asistir' }).click();
    await expect(client.getByText(/Cancelar dentro de las 24 horas/)).toBeVisible();
    // es-US, not es-ES. The sentence is Spanish and the amount is dollars,
    // which is the pairing the picture exists to show.
    await expect(client.getByText(/\$90\.00/)).toBeVisible();
    await client.screenshot({ path: `${shot}/fee-disclosure-es.png` });
    await phone.close();

    // The vocabulary itself. Not a screen and not seeded — /design renders the
    // same components the pages above render, reading the same tokens, which is
    // what stops the style guide from drifting into fiction. Captured last
    // because it is the only picture here that does not care who is signed in.
    await page.goto('/design');
    await expect(page.getByRole('heading', { name: 'Design system' })).toBeVisible();
    // Exact: the dialog specimen's own heading reads "Break-glass access
    // required", and a substring match takes both.
    await expect(page.getByRole('heading', { name: 'Break-glass', exact: true })).toBeVisible();
    await page.screenshot({ path: `${shot}/design-system.png`, fullPage: true });
  });
});
