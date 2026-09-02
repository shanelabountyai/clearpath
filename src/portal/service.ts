import { randomBytes } from 'node:crypto';
import { auditEvent, guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { clientTarget } from '../clients/repository';
import { systemClock, DAY, type Clock } from '../clock';
import { prisma, type Tx } from '../db';
import { Conflict, NotFound } from '../errors';
import { queueToClient } from '../messaging/outbox';

/**
 * The client's own door.
 *
 * Same shape as the form link, for the same reasons: opaque, expiring, personal,
 * and carrying no PHI in the URL. What is behind it is deliberately narrow —
 * when you are coming in, with whom, and in what form. Not a note, not a score,
 * not a fee, not a form they have not been sent, and not their own record.
 *
 * There is no login. A client with a link is authenticated by holding it, which
 * is exactly as strong as email, which is how they got it. That is why the door
 * shows so little: the blast radius of a forwarded link is the appointment
 * times of one person, and the audit log knows the link was opened.
 */

export const newPortalToken = () => randomBytes(24).toString('base64url');

export interface IssuePortalLink {
  clientId: string;
  expiresInDays?: number;
  baseUrl?: string;
  clock?: Clock;
}

/** Issue (or re-issue) a client their link, and message it to them. */
export async function issuePortalLink(actor: Actor, input: IssuePortalLink) {
  const clock = input.clock ?? systemClock;
  const token = newPortalToken();
  const expiresAt = new Date(clock.now().getTime() + (input.expiresInDays ?? 90) * DAY);

  return guarded(
    {
      actor, action: 'create', resource: 'portal_link', clientId: input.clientId,
      target: await clientTarget(input.clientId),
    },
    async (tx) => {
      const link = await tx.portalLink.create({
        data: { clientId: input.clientId, token, expiresAt },
      });
      await queueToClient(
        {
          clientId: input.clientId,
          templateKey: 'portal_link',
          scheduledFor: clock.now(),
          link: `${input.baseUrl ?? 'http://localhost:3700'}/p/${token}`,
        },
        tx,
      );
      return link;
    },
  );
}

async function liveLink(token: string, clock: Clock) {
  const link = await prisma.portalLink.findUnique({ where: { token } });
  if (!link) throw new NotFound('PortalLink');
  if (link.expiresAt < clock.now()) throw new Conflict('This link has expired', 'expired');
  return link;
}

/**
 * What the client sees: their next appointments, and nothing else.
 *
 * Note the select. The clinician's name and the room are here because a client
 * turning up needs them. The appointment type is not — "intake" versus
 * "extended" is a clinical shape, and it is on the deny-list for messages for
 * the same reason it is absent here.
 */
export async function openPortal(token: string, opts: { clock?: Clock } = {}) {
  const clock = opts.clock ?? systemClock;
  const link = await liveLink(token, clock);
  const now = clock.now();

  // One transaction: the read, the touch and the audit row commit together, the
  // same rule every staff-side read follows through `guarded`. The token door
  // sits outside the matrix, not outside the log.
  const { client, settings, appointments } = await prisma.$transaction(async (tx) => {
    const client = await tx.client.findUniqueOrThrow({
      where: { id: link.clientId },
      select: { id: true, firstName: true },
    });
    const settings = await tx.practiceSettings.findUnique({
      where: { id: 1 }, select: { messagingName: true },
    });
    const appointments = await tx.appointment.findMany({
      where: {
        clientId: link.clientId,
        startAt: { gte: now },
        status: { notIn: ['cancelled', 'late_cancelled'] },
      },
      select: {
        id: true, startAt: true, endAt: true, modality: true, status: true,
        clinician: { select: { name: true } },
        room: { select: { name: true } },
        rescheduleRequests: {
          where: { status: 'open' },
          select: { id: true, reason: true, createdAt: true },
        },
      },
      orderBy: { startAt: 'asc' },
    });

    await tx.portalLink.update({ where: { id: link.id }, data: { lastOpenedAt: now } });

    // The client is the actor: they opened their own door. Logged like any
    // other read of their record, because that is what it is.
    await auditEvent(
      { id: link.clientId, role: 'client' },
      'read', 'portal_link',
      { resourceId: link.id, clientId: link.clientId, rule: 'token' },
      tx as Tx,
    );

    return { client, settings, appointments };
  });

  return {
    firstName: client.firstName,
    practice: settings?.messagingName ?? 'Stillwater',
    appointments,
  };
}

export type RescheduleReason =
  | 'cannot_make_it' | 'need_a_different_time' | 'prefer_earlier' | 'prefer_later';

/**
 * Ask for a different time. It books nothing.
 *
 * The same rule as the waitlist: a request surfaces to front desk, who rebook
 * by hand. Automatic rebooking would mean a client moving a session without a
 * person seeing that they moved it, and the pattern of somebody rescheduling
 * every week is exactly the sort of thing a practice needs to notice.
 */
export async function requestReschedule(
  token: string,
  appointmentId: string,
  reason: RescheduleReason,
  opts: { clock?: Clock } = {},
) {
  const clock = opts.clock ?? systemClock;
  const link = await liveLink(token, clock);

  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { id: true, clientId: true, status: true, startAt: true },
  });
  // Not "forbidden": a token that names someone else's appointment should learn
  // nothing about whether it exists.
  if (!appt || appt.clientId !== link.clientId) throw new NotFound('Appointment');
  if (appt.status === 'cancelled' || appt.status === 'late_cancelled') {
    throw new Conflict('That appointment is already cancelled', 'already_cancelled');
  }
  if (appt.startAt < clock.now()) {
    throw new Conflict('That appointment has already happened', 'in_the_past');
  }

  const existing = await prisma.rescheduleRequest.findFirst({
    where: { appointmentId, status: 'open' },
  });
  if (existing) return existing;

  return prisma.$transaction(async (tx) => {
    const request = await tx.rescheduleRequest.create({
      data: { appointmentId, clientId: link.clientId, reason },
    });
    await auditEvent(
      { id: link.clientId, role: 'client' },
      'create', 'appointment',
      { resourceId: appointmentId, clientId: link.clientId, rule: 'token' },
      tx as Tx,
    );
    return request;
  });
}

// ──────────────────────────── the front-desk side ────────────────────────────

/** Open requests, oldest first. Operational: a reason code and a time. */
export async function openRescheduleRequests(actor: Actor) {
  return guarded(
    { actor, action: 'read', resource: 'appointment' },
    (tx) =>
      tx.rescheduleRequest.findMany({
        where: { status: 'open' },
        select: {
          id: true, reason: true, createdAt: true, clientId: true,
          client: { select: { code: true, firstName: true, lastName: true } },
          appointment: {
            select: {
              id: true, startAt: true, modality: true,
              clinician: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
  );
}

/** Mark a request dealt with. Rebooking itself stays a deliberate, separate act. */
export async function resolveRescheduleRequest(
  actor: Actor,
  requestId: string,
  status: 'handled' | 'declined',
  opts: { clock?: Clock } = {},
) {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: requestId },
    select: { clientId: true, appointmentId: true },
  });
  if (!request) throw new NotFound('RescheduleRequest');

  return guarded(
    {
      actor, action: 'update', resource: 'appointment',
      resourceId: request.appointmentId, clientId: request.clientId,
    },
    (tx) =>
      tx.rescheduleRequest.update({
        where: { id: requestId },
        data: { status, handledById: actor.id, handledAt: (opts.clock ?? systemClock).now() },
      }),
  );
}
