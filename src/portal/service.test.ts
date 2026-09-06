import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Conflict, Forbidden, NotFound } from '../errors';
import { fixedClock, DAY, HOUR } from '../clock';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from '../scheduling/booking';
import { bookGroupSession } from '../scheduling/groups';
import { cancelAppointment, setStatus } from '../scheduling/lifecycle';
import { runReminderHorizon } from '../scheduling/reminders';
import { indiscreetTerms } from '../messaging/outbox';
import { LANGUAGES } from '../messaging/language';
import { PORTAL_COPY } from './copy';
import { CADENCES } from '../scheduling/confirmation';
import { can } from '../auth/permissions';
import {
  chooseCadence, confirmAppointment, declineAppointment, ensurePortalLink, issuePortalLink,
  openPortal, openRescheduleRequests, requestReschedule, resolveRescheduleRequest,
} from './service';

const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;
const clock = fixedClock('2026-08-25T12:00:00Z');

let desk: Awaited<ReturnType<typeof makeUser>>;
let mine: Awaited<ReturnType<typeof makeUser>>;
let client: Awaited<ReturnType<typeof makeClient>>;

const bookOne = (clientId: string, clinicianId: string, startMinute = THREE_PM) =>
  bookAppointment(actor(desk), {
    clientId, clinicianId, date: TUESDAY, startMinute, type: 'standard', modality: 'in_person',
  });

beforeEach(async () => {
  await resetDb();
  await settings({ messagingName: 'Stillwater' });
  desk = await makeUser('front_desk');
  mine = await makeUser('therapist');
  client = await makeClient(mine.id);
  await makeRoom('Room 1');
});
afterAll(() => prisma.$disconnect());

describe('issuing the door', () => {
  it('sends the client a link that says nothing about why they attend', async () => {
    await issuePortalLink(actor(desk), { clientId: client.id, clock });

    const message = await prisma.outboxMessage.findFirstOrThrow();
    const text = `${message.subject} ${message.body}`.toLowerCase();
    expect(indiscreetTerms(text)).toEqual([]);
    expect(message.body).toContain('/p/');
  });

  it('honours a client who wants no messages at all', async () => {
    const quiet = await makeClient(mine.id);
    await prisma.client.update({ where: { id: quiet.id }, data: { reminderPreference: 'none' } });

    await issuePortalLink(actor(desk), { clientId: quiet.id, clock });
    expect(await prisma.outboxMessage.count()).toBe(0);
    // The link still exists — the client can be given it another way.
    expect(await prisma.portalLink.count({ where: { clientId: quiet.id } })).toBe(1);
  });

  it('lets the treating clinician issue one, and refuses a stranger', async () => {
    await expect(issuePortalLink(actor(mine), { clientId: client.id, clock })).resolves.toBeTruthy();
    const other = await makeUser('therapist');
    await expect(
      issuePortalLink(actor(other), { clientId: client.id, clock }),
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it('logs the issue against the client', async () => {
    await issuePortalLink(actor(desk), { clientId: client.id, clock });
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { resource: 'portal_link' } });
    expect(row.clientId).toBe(client.id);
    expect(row.action).toBe('create');
  });
});

describe('what is behind the door', () => {
  const open = async () => {
    const link = await issuePortalLink(actor(desk), { clientId: client.id, clock });
    return { link, view: await openPortal(link.token, { clock }) };
  };

  it('shows the next appointments, with who and where', async () => {
    await bookOne(client.id, mine.id);
    const { view } = await open();

    expect(view.appointments).toHaveLength(1);
    expect(view.appointments[0]!.clinician.name).toBe(mine.name);
    expect(view.appointments[0]!.room!.name).toBe('Room 1');
    expect(view.practice).toBe('Stillwater');
  });

  it('carries nothing clinical — no note, no score, no fee, no session type', async () => {
    await bookOne(client.id, mine.id);
    const { view } = await open();
    const serialised = JSON.stringify(view);

    for (const key of ['feeCents', 'totalScore', 'content', 'type', 'needsReview', 'chargeFeeCents']) {
      expect(serialised).not.toContain(key);
    }
  });

  it('leaves out appointments that are past or cancelled', async () => {
    const upcoming = await bookOne(client.id, mine.id);
    const cancelled = await bookOne(client.id, mine.id, 16 * 60);
    await cancelAppointment(actor(desk), cancelled.id, { clock });

    const { view } = await open();
    expect(view.appointments.map((a) => a.id)).toEqual([upcoming.id]);
  });

  it('shows one client only their own appointments', async () => {
    const neighbour = await makeClient(mine.id);
    await bookOne(client.id, mine.id);
    await bookOne(neighbour.id, mine.id, 16 * 60);

    const { view } = await open();
    expect(view.appointments).toHaveLength(1);
  });

  it('refuses an unknown token, and an expired one', async () => {
    await expect(openPortal('not-a-token', { clock })).rejects.toBeInstanceOf(NotFound);

    const link = await issuePortalLink(actor(desk), { clientId: client.id, expiresInDays: 1, clock });
    const later = fixedClock(new Date(clock.now().getTime() + 3 * DAY));
    await expect(openPortal(link.token, { clock: later })).rejects.toMatchObject({ code: 'expired' });
  });

  it('logs the open as the client, by token', async () => {
    await open();
    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { resource: 'portal_link', action: 'read' },
    });
    expect(row.actorId).toBe(client.id);
    expect(row.actorRole).toBe('client');
    expect(row.rule).toBe('token');
  });
});

describe('asking for a different time', () => {
  const linkFor = async (c = client) =>
    (await issuePortalLink(actor(desk), { clientId: c.id, clock })).token;

  it('records a request without moving anything', async () => {
    const appt = await bookOne(client.id, mine.id);
    const token = await linkFor();

    const request = await requestReschedule(token, appt.id, 'cannot_make_it', { clock });
    expect(request.status).toBe('open');

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.startAt.getTime()).toBe(appt.startAt.getTime());
    expect(after.status).toBe('scheduled');
  });

  it('will not let a token reach another client\'s appointment', async () => {
    const neighbour = await makeClient(mine.id);
    const theirs = await bookOne(neighbour.id, mine.id);
    const token = await linkFor();

    await expect(
      requestReschedule(token, theirs.id, 'cannot_make_it', { clock }),
    ).rejects.toBeInstanceOf(NotFound);
    expect(await prisma.rescheduleRequest.count()).toBe(0);
  });

  it('refuses a cancelled or already-past appointment', async () => {
    const appt = await bookOne(client.id, mine.id);
    const token = await linkFor();
    await cancelAppointment(actor(desk), appt.id, { clock });

    await expect(
      requestReschedule(token, appt.id, 'cannot_make_it', { clock }),
    ).rejects.toMatchObject({ code: 'already_cancelled' });

    const past = await bookOne(client.id, mine.id, 16 * 60);
    const afterwards = fixedClock(new Date(past.startAt.getTime() + DAY));
    await expect(
      requestReschedule(token, past.id, 'cannot_make_it', { clock: afterwards }),
    ).rejects.toMatchObject({ code: 'in_the_past' });
  });

  it('is idempotent while one is still open', async () => {
    const appt = await bookOne(client.id, mine.id);
    const token = await linkFor();

    const first = await requestReschedule(token, appt.id, 'cannot_make_it', { clock });
    const second = await requestReschedule(token, appt.id, 'prefer_later', { clock });
    expect(second.id).toBe(first.id);
    expect(await prisma.rescheduleRequest.count()).toBe(1);
  });

  it('logs the request as the client', async () => {
    const appt = await bookOne(client.id, mine.id);
    await requestReschedule(await linkFor(), appt.id, 'prefer_earlier', { clock });

    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { actorRole: 'client', action: 'create', resource: 'appointment' },
    });
    expect(row.clientId).toBe(client.id);
    expect(row.rule).toBe('token');
  });
});

describe('the front-desk side', () => {
  const raise = async () => {
    const appt = await bookOne(client.id, mine.id);
    const token = (await issuePortalLink(actor(desk), { clientId: client.id, clock })).token;
    return requestReschedule(token, appt.id, 'need_a_different_time', { clock });
  };

  it('lists open requests with a reason code and no message from the client', async () => {
    await raise();
    const queue = await openRescheduleRequests(actor(desk));

    expect(queue).toHaveLength(1);
    expect(queue[0]!.reason).toBe('need_a_different_time');
    // There is no free-text field to leak clinical content to front desk.
    expect(Object.keys(queue[0]!)).not.toContain('note');
  });

  it('drops a request off the queue once it is handled', async () => {
    const request = await raise();
    await resolveRescheduleRequest(actor(desk), request.id, 'handled', { clock });

    expect(await openRescheduleRequests(actor(desk))).toEqual([]);
    const row = await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.handledById).toBe(desk.id);
    expect(row.handledAt).not.toBeNull();
  });

  it('refuses a role with no appointment permission', async () => {
    await raise();
    const auditor = await makeUser('auditor');
    await expect(openRescheduleRequests(actor(auditor))).rejects.toBeInstanceOf(Forbidden);
  });

  it('logs handling it against the appointment and the client', async () => {
    const request = await raise();
    await resolveRescheduleRequest(actor(desk), request.id, 'declined', { clock });

    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { actorId: desk.id, action: 'update', resource: 'appointment' },
      orderBy: { at: 'desc' },
    });
    expect(row.clientId).toBe(client.id);
  });
});

describe('the door is narrow on purpose', () => {
  it('never puts the client id or a name in the link itself', async () => {
    const link = await issuePortalLink(actor(desk), { clientId: client.id, clock });
    expect(link.token).not.toContain(client.id);
    expect(link.token).not.toContain(client.lastName);
    expect(link.token.length).toBeGreaterThanOrEqual(32);
  });

  it('gives two clients unrelated tokens', async () => {
    const other = await makeClient(mine.id);
    const a = await issuePortalLink(actor(desk), { clientId: client.id, clock });
    const b = await issuePortalLink(actor(desk), { clientId: other.id, clock });
    expect(a.token).not.toBe(b.token);
  });

  it('cannot be used to submit anything clinical', async () => {
    const token = (await issuePortalLink(actor(desk), { clientId: client.id, clock })).token;
    const view = await openPortal(token, { clock });
    // The whole surface: a first name, a practice name, appointment times, and
    // which language to render them in. `language` is the only field added here
    // since this spec was written, and it is on the safe side of the line for a
    // reason worth stating: it is a fact about how to write to this person, not
    // about why they attend, and it is a fact they already hold — a leaked link
    // discloses that the holder reads Spanish, which the message that carried
    // the link disclosed first.
    // `reminderCadence` is on the same side of the line, for a sharper reason:
    // it is the one thing this door can change, so showing it is what lets a
    // client whose link was misused see that it was.
    expect(Object.keys(view).sort())
      .toEqual(['appointments', 'firstName', 'language', 'practice', 'reminderCadence']);
  });
});

/**
 * P0-4: the client's door gains the one destructive thing it can do.
 *
 * The appointment is the standing Tuesday 3pm; the clock moves around it rather
 * than the appointment moving, so "five days out" and "two hours out" are the
 * same row seen from two moments.
 */
describe('confirming and declining', () => {
  const START = new Date('2026-09-01T19:00:00Z');
  const fiveDaysOut = fixedClock(new Date(START.getTime() - 5 * DAY));
  const twoHoursOut = fixedClock(new Date(START.getTime() - 2 * HOUR));

  /** Booked, asked, and sitting at `pending` — the state the door acts on. */
  async function asked(at = fiveDaysOut) {
    const appt = await bookOne(client.id, mine.id);
    await prisma.client.update({
      where: { id: client.id }, data: { email: 'tc@example.test' },
    });
    await prisma.appointment.update({
      where: { id: appt.id }, data: { confirmation: 'pending' },
    });
    const token = (await issuePortalLink(actor(desk), { clientId: client.id, clock: at })).token;
    return { appt, token };
  }

  it('records the answer without touching the practice\'s own record of the session', async () => {
    const { appt, token } = await asked();
    await confirmAppointment(token, appt.id, { clock: fiveDaysOut });

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.confirmation).toBe('confirmed');
    // `status: 'confirmed'` is a front-desk lifecycle step, and a client saying
    // yes is not front desk saying they arrived. D-02, in one assertion.
    expect(after.status).toBe('scheduled');
    expect(after.chargeFeeCents).toBeNull();
  });

  it('is the same confirmation however many times it is tapped', async () => {
    const { appt, token } = await asked();
    await confirmAppointment(token, appt.id, { clock: fiveDaysOut });
    await confirmAppointment(token, appt.id, { clock: fiveDaysOut });
    await confirmAppointment(token, appt.id, { clock: fiveDaysOut });

    expect(await prisma.auditEvent.count({
      where: { actorRole: 'client', action: 'update', resource: 'appointment' },
    })).toBe(1);
  });

  it('logs the open, the confirm and the decline as the client, by token', async () => {
    const { appt, token } = await asked();
    await openPortal(token, { clock: fiveDaysOut });
    await confirmAppointment(token, appt.id, { clock: fiveDaysOut });

    const second = await bookOne(client.id, mine.id, 16 * 60);
    await prisma.appointment.update({ where: { id: second.id }, data: { confirmation: 'pending' } });
    await declineAppointment(token, second.id, { clock: fiveDaysOut });

    const rows = await prisma.auditEvent.findMany({ where: { actorRole: 'client' } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.actorId).toBe(client.id);
      expect(row.rule).toBe('token');
      expect(row.allowed).toBe(true);
    }
  });

  it('declining outside the window cancels, free, in one write', async () => {
    const { appt, token } = await asked();
    await declineAppointment(token, appt.id, { clock: fiveDaysOut });

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe('cancelled');
    expect(after.confirmation).toBe('declined');
    expect(after.chargeFeeCents).toBeNull();
    expect(after.cancelledById).toBe(client.id);
  });

  it('declining inside the window asks a second time before it charges', async () => {
    const { appt, token } = await asked(twoHoursOut);

    await expect(declineAppointment(token, appt.id, { clock: twoHoursOut }))
      .rejects.toMatchObject({ code: 'fee_acknowledgement_required' });

    // Nothing happened. The interstitial is a question, not a receipt.
    const untouched = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(untouched.status).toBe('scheduled');
    expect(untouched.confirmation).toBe('pending');

    await declineAppointment(token, appt.id, { clock: twoHoursOut, acknowledgeFee: true });
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe('late_cancelled');
    expect(after.confirmation).toBe('declined');
    // The practice's existing late-cancel fee, decided by `classifyCancellation`
    // — this feature adds no money logic of its own to the decline.
    expect(after.chargeFeeCents).toBe(9_000);
  });

  it('acknowledging a fee that does not apply buys nothing', async () => {
    const { appt, token } = await asked();
    await declineAppointment(token, appt.id, { clock: fiveDaysOut, acknowledgeFee: true });

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe('cancelled');
    expect(after.chargeFeeCents).toBeNull();
  });

  it('will not let a token reach another client\'s appointment', async () => {
    const neighbour = await makeClient(mine.id);
    const theirs = await bookOne(neighbour.id, mine.id, 16 * 60);
    const { token } = await asked();

    await expect(confirmAppointment(token, theirs.id, { clock: fiveDaysOut }))
      .rejects.toBeInstanceOf(NotFound);
    await expect(declineAppointment(token, theirs.id, { clock: fiveDaysOut, acknowledgeFee: true }))
      .rejects.toBeInstanceOf(NotFound);

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(after.status).toBe('scheduled');
    expect(after.confirmation).toBe('not_required');
  });

  it('refuses an expired link and leaves the answer where it was', async () => {
    const appt = await bookOne(client.id, mine.id);
    await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation: 'pending' } });
    const link = await issuePortalLink(actor(desk), {
      clientId: client.id, expiresInDays: 1, clock: fiveDaysOut,
    });
    const later = fixedClock(new Date(fiveDaysOut.now().getTime() + 3 * DAY));

    await expect(confirmAppointment(link.token, appt.id, { clock: later }))
      .rejects.toMatchObject({ code: 'expired' });

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.confirmation).toBe('pending');
  });

  it('refuses an appointment that is already cancelled or already past', async () => {
    const { appt, token } = await asked();
    await cancelAppointment(actor(desk), appt.id, { clock: fiveDaysOut });
    await expect(confirmAppointment(token, appt.id, { clock: fiveDaysOut }))
      .rejects.toMatchObject({ code: 'already_cancelled' });

    const past = await bookOne(client.id, mine.id, 16 * 60);
    const afterwards = fixedClock(new Date(past.startAt.getTime() + DAY));
    await expect(confirmAppointment(token, past.id, { clock: afterwards }))
      .rejects.toMatchObject({ code: 'in_the_past' });
  });

  it('does not move a session the front desk has already checked in', async () => {
    const { appt, token } = await asked();
    await setStatus(actor(desk), appt.id, 'arrived', { clock: fiveDaysOut });
    await confirmAppointment(token, appt.id, { clock: fiveDaysOut });

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe('arrived');
    expect(after.confirmation).toBe('confirmed');
  });
});

/** P0-8: five people's answers are five facts. */
describe('a group session confirms per attendee', () => {
  const START = new Date('2026-09-01T19:00:00Z');
  const fiveDaysOut = fixedClock(new Date(START.getTime() - 5 * DAY));

  it('one attendee declining leaves every co-attendee untouched', async () => {
    const others = [await makeClient(mine.id), await makeClient(mine.id)];
    const group = await bookGroupSession(actor(desk), {
      clinicianId: mine.id,
      clientIds: [client.id, ...others.map((c) => c.id)],
      date: TUESDAY,
      startMinute: THREE_PM,
      topic: 'Tuesday skills group',
    });
    const mineAppt = group.appointments.find((a) => a.clientId === client.id)!;
    await prisma.appointment.updateMany({
      where: { groupSessionId: group.id }, data: { confirmation: 'pending' },
    });

    const token = (await issuePortalLink(actor(desk), { clientId: client.id, clock: fiveDaysOut })).token;
    await declineAppointment(token, mineAppt.id, { clock: fiveDaysOut });

    const rows = await prisma.appointment.findMany({ where: { groupSessionId: group.id } });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(1);
    expect(rows.filter((r) => r.confirmation === 'declined')).toHaveLength(1);
    // The room and the clinician stay reserved for the people still coming.
    for (const row of rows.filter((r) => r.id !== mineAppt.id)) {
      expect(row.status).toBe('scheduled');
      expect(row.confirmation).toBe('pending');
      expect(row.roomId).toBe(mineAppt.roomId);
    }
  });

  it('gives every attendee their own reminders and their own door', async () => {
    const others = [await makeClient(mine.id), await makeClient(mine.id)];
    for (const c of [client, ...others]) {
      await prisma.client.update({ where: { id: c.id }, data: { email: 'tc@example.test' } });
    }
    const group = await bookGroupSession(actor(desk), {
      clinicianId: mine.id,
      clientIds: [client.id, ...others.map((c) => c.id)],
      date: TUESDAY,
      startMinute: THREE_PM,
      topic: 'Tuesday skills group',
    });
    await prisma.appointment.updateMany({
      where: { groupSessionId: group.id },
      data: {
        createdAt: new Date(START.getTime() - 30 * DAY),
        bookedAt: new Date(START.getTime() - 30 * DAY),
      },
    });

    await runReminderHorizon(fiveDaysOut);

    for (const attendee of group.appointments) {
      expect(await prisma.appointmentReminder.count({ where: { appointmentId: attendee.id } })).toBe(1);
    }
    expect(await prisma.portalLink.count()).toBe(3);
    // Three separate doors, and none of the bodies names the group.
    const bodies = (await prisma.outboxMessage.findMany({ where: { templateKey: 'appointment_reminder' } }))
      .map((m) => m.body);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).not.toContain('skills group');
    expect(new Set(bodies).size).toBe(3);
  });
});

it('the cadence reuses a door the practice already issued', async () => {
  const clock = fixedClock('2026-08-25T12:00:00Z');
  const existing = await issuePortalLink(actor(desk), { clientId: client.id, clock });
  const again = await ensurePortalLink(client.id, clock);
  expect(again.id).toBe(existing.id);
  expect(await prisma.portalLink.count({ where: { clientId: client.id } })).toBe(1);
});

it('mints a fresh door once the old one has expired', async () => {
  const clock = fixedClock('2026-08-25T12:00:00Z');
  await issuePortalLink(actor(desk), { clientId: client.id, expiresInDays: 1, clock });
  const later = fixedClock(new Date(clock.now().getTime() + 3 * DAY));

  const fresh = await ensurePortalLink(client.id, later);
  expect(fresh.expiresAt.getTime()).toBeGreaterThan(later.now().getTime());
  expect(await prisma.portalLink.count({ where: { clientId: client.id } })).toBe(2);
});

/**
 * The other half of the translated reminder.
 *
 * A Spanish message saying "avísenos si va a venir" that links to an English
 * page with two English buttons is a loop the client cannot complete — and this
 * feature's fee rests on them completing it, which would make an untranslated
 * door a way of charging somebody for a language barrier.
 */
describe('the door speaks the language the message did', () => {
  it('tells the page which language to render in', async () => {
    await prisma.client.update({ where: { id: client.id }, data: { language: 'es' } });
    const link = await issuePortalLink(actor(desk), { clientId: client.id, clock });

    const view = await openPortal(link.token, { clock });
    expect(view.language).toBe('es');
    expect(PORTAL_COPY[view.language].confirmButton).toBe('Sí, allí estaré');
  });

  it('defaults to English for a client nobody set a language on', async () => {
    const link = await issuePortalLink(actor(desk), { clientId: client.id, clock });
    expect((await openPortal(link.token, { clock })).language).toBe('en');
  });

  /**
   * The door is behind a token, but a token arrives in a message on a phone and
   * the page is one tap from a lock screen. Every string on it passes the same
   * gate the messages do — in both languages, against the union of both lists.
   */
  it('says nothing on any screen that a message could not say', () => {
    for (const language of LANGUAGES) {
      const copy = PORTAL_COPY[language];
      const strings = [
        copy.greeting('Test'), copy.intro, copy.askedNotice, copy.confirmedNotice,
        copy.declinedNotice, copy.nothingBooked, copy.invalidLink, copy.expiredLink,
        copy.linkHelp, copy.with('Dr Example'), copy.byVideo, copy.alreadyConfirmed,
        copy.confirmButton, copy.declineButton, copy.feeWarning(24, '$90.00'),
        copy.feeConfirmButton, copy.feeKeepLink, copy.reasonLabel, copy.askToChange,
        copy.changePending, copy.footer, ...Object.values(copy.reasons),
      ];
      for (const text of strings) {
        expect(indiscreetTerms(text), `${language}: ${text}`).toEqual([]);
      }
    }
  });

  it('has the cadence copy in every language too', () => {
    for (const language of LANGUAGES) {
      for (const c of CADENCES) {
        expect(PORTAL_COPY[language].cadences[c].length, `${language}.${c}`).toBeGreaterThan(0);
      }
    }
  });

  it('has every string in every language, so no screen renders undefined', () => {
    // `Record<Language, PortalCopy>` makes this a type error rather than a
    // runtime one, and this is the runtime half: a key present but empty would
    // typecheck and still show somebody a blank button.
    for (const language of LANGUAGES) {
      const copy = PORTAL_COPY[language];
      for (const [key, value] of Object.entries(copy)) {
        if (typeof value === 'string') expect(value.length, `${language}.${key}`).toBeGreaterThan(0);
      }
      for (const [code, label] of Object.entries(copy.reasons)) {
        expect(label.length, `${language}.reasons.${code}`).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * The second thing the token may do, and the line it stops at.
 *
 * A cadence change is the only write behind this door that touches the client
 * rather than an appointment, so what it *cannot* reach is as much the spec as
 * what it can.
 */
describe('choosing how many reminders, from behind the token', () => {
  const clock = fixedClock('2026-09-01T12:00:00Z');

  it('narrows the cadence and records the client as the actor', async () => {
    const link = await issuePortalLink(actor(desk), { clientId: client.id, clock });

    const out = await chooseCadence(link.token, 'day_before', { clock });
    expect(out.reminderCadence).toBe('day_before');

    const [row] = await prisma.auditEvent.findMany({
      where: { resource: 'reminder_cadence', clientId: client.id },
    });
    // The client did this, and the trail says so rather than borrowing whoever
    // ran the request. `token` is the rule, exactly as on a confirmation.
    expect(row).toMatchObject({ actorRole: 'client', actorId: client.id, allowed: true, rule: 'token' });
    expect(row!.reason).toBe('cadence:day_before');
  });

  it('cannot reach the channel, which is where the fee exemption lives', async () => {
    const link = await issuePortalLink(actor(desk), { clientId: client.id, clock });
    // There is no argument for it: the narrowness is in the signature, and the
    // matrix says the same thing again for anybody reading policy rather than
    // code. A client on `none` is never asked and so never charged, which is
    // why a forwarded link may not put somebody there.
    await chooseCadence(link.token, 'day_of', { clock });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.reminderPreference).not.toBe('none');
    expect(can({ id: client.id, role: 'client' }, 'update', 'client', { ownerClientId: client.id }).allowed)
      .toBe(false);
  });

  it('reaches one client and no other', async () => {
    const other = await makeClient(mine.id);
    const link = await issuePortalLink(actor(desk), { clientId: client.id, clock });

    await chooseCadence(link.token, 'day_of', { clock });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: other.id } })).reminderCadence)
      .toBe('full');
  });

  it('refuses an expired link, like every other write behind the door', async () => {
    const link = await issuePortalLink(actor(desk), { clientId: client.id, expiresInDays: 1, clock });
    const later = fixedClock('2026-10-01T12:00:00Z');

    await expect(chooseCadence(link.token, 'day_of', { clock: later }))
      .rejects.toMatchObject({ code: 'expired' });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).reminderCadence)
      .toBe('full');
  });

  it('shows the client what they are set to, so a misused link is visible', async () => {
    const link = await issuePortalLink(actor(desk), { clientId: client.id, clock });
    await chooseCadence(link.token, 'day_of', { clock });

    expect((await openPortal(link.token, { clock })).reminderCadence).toBe('day_of');
  });
});
