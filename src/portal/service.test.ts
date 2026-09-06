import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Conflict, Forbidden, NotFound } from '../errors';
import { fixedClock, DAY } from '../clock';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from '../scheduling/booking';
import { cancelAppointment } from '../scheduling/lifecycle';
import { DENY_LIST } from '../messaging/outbox';
import {
  issuePortalLink, openPortal, openRescheduleRequests, requestReschedule,
  resolveRescheduleRequest,
} from './service';

const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;
const clock = fixedClock('2026-08-25T12:00:00Z');

let desk: Awaited<ReturnType<typeof makeUser>>;
let mine: Awaited<ReturnType<typeof makeUser>>;
let client: Awaited<ReturnType<typeof makeClient>>;

/** Tuesdays 9:00–17:00. A clinician with no pattern works no hours at all. */
const worksTuesdays = (userId: string) =>
  prisma.availability.create({ data: { userId, weekday: 2, startMinute: 540, endMinute: 1020 } });

const bookOne = (clientId: string, clinicianId: string, startMinute = THREE_PM) =>
  bookAppointment(actor(desk), {
    clientId, clinicianId, date: TUESDAY, startMinute, type: 'standard', modality: 'in_person',
  });

beforeEach(async () => {
  await resetDb();
  await settings({ messagingName: 'Stillwater' });
  desk = await makeUser('front_desk');
  mine = await makeUser('therapist');
  await worksTuesdays(mine.id);
  client = await makeClient(mine.id);
  await makeRoom('Room 1');
});
afterAll(() => prisma.$disconnect());

describe('issuing the door', () => {
  it('sends the client a link that says nothing about why they attend', async () => {
    await issuePortalLink(actor(desk), { clientId: client.id, clock });

    const message = await prisma.outboxMessage.findFirstOrThrow();
    const text = `${message.subject} ${message.body}`.toLowerCase();
    expect(DENY_LIST.some((term) => text.includes(term))).toBe(false);
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
    await worksTuesdays(other.id);
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
    // The whole surface: a first name, a practice name, and appointment times.
    expect(Object.keys(view).sort()).toEqual(['appointments', 'firstName', 'practice']);
  });
});
