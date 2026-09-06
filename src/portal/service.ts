import { randomBytes } from 'node:crypto';
import { auditEvent, guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { clientTarget, setReminderCadence } from '../clients/repository';
import type { ReminderCadence } from '../scheduling/confirmation';
import { systemClock, DAY, type Clock } from '../clock';
import { prisma, type Tx } from '../db';
import { Conflict, NotFound } from '../errors';
import { indiscreetTerms, queueToClient } from '../messaging/outbox';
import { cancelAppointment, classifyCancellation } from '../scheduling/lifecycle';

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

/**
 * Opaque, and re-rolled until it is also discreet.
 *
 * The token is substituted into a client-facing body, so `assertDiscreet` scans
 * it along with everything else — and 32 random base64url characters land on a
 * four-letter deny-list term about once in 36,000. At three reminders a week
 * for seventy standing clients that is a send that throws, in the middle of a
 * horizon run, a couple of times a year. One re-roll costs nothing and takes
 * the whole class of failure off the table for every template.
 */
const newPortalToken = (): string => {
  for (;;) {
    const token = randomBytes(24).toString('base64url');
    if (!indiscreetTerms(token).length) return token;
  }
};

interface IssuePortalLink {
  clientId: string;
  expiresInDays?: number;
  baseUrl?: string;
  clock?: Clock;
}

const PORTAL_LINK_DAYS = 90;

/**
 * The client's live link, minted if they have none.
 *
 * The cadence needs a link in every reminder and must not mint a fourth one
 * every week, so it asks for the door rather than for a new door. Reusing the
 * live link is also what makes the reminder and the portal message the same
 * link: a client with two tokens has two revocation stories, which is the very
 * thing D-05 refused a second token type over.
 */
export async function ensurePortalLink(
  clientId: string,
  clock: Clock,
  db: Tx | typeof prisma = prisma,
) {
  const now = clock.now();
  const live = await db.portalLink.findFirst({
    where: { clientId, expiresAt: { gt: now } },
    orderBy: { expiresAt: 'desc' },
  });
  if (live) return live;

  return db.portalLink.create({
    data: {
      clientId,
      token: newPortalToken(),
      expiresAt: new Date(now.getTime() + PORTAL_LINK_DAYS * DAY),
    },
  });
}

/** Issue (or re-issue) a client their link, and message it to them. */
export async function issuePortalLink(actor: Actor, input: IssuePortalLink) {
  const clock = input.clock ?? systemClock;
  const token = newPortalToken();
  const expiresAt = new Date(clock.now().getTime() + (input.expiresInDays ?? PORTAL_LINK_DAYS) * DAY);

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
      // Their language, because the door has to be readable by whoever the
      // reminder was written for. A Spanish reminder linking to an English
      // page is a loop the client cannot complete — and the fee rests on them
      // completing it.
      select: { id: true, firstName: true, language: true, reminderCadence: true },
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
        // The client's own answer, so the door can show what they already said
        // rather than asking again. Not `chargeFeeCents`, not the type.
        confirmation: true,
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
    language: client.language,
    // Shown on the door so a client can see what they are set to — and so one
    // whose link was misused can see it was changed.
    reminderCadence: client.reminderCadence,
    practice: settings?.messagingName ?? 'Stillwater',
    appointments,
  };
}

/**
 * The one appointment a token may act on, or nothing.
 *
 * Shared by every write behind the door so the three refusals stay identical:
 * a token naming somebody else's appointment learns only that there is nothing
 * there, and a cancelled or past session is a conflict rather than a silent
 * no-op.
 */
async function ownAppointment(
  link: { clientId: string },
  appointmentId: string,
  clock: Clock,
) {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { id: true, clientId: true, status: true, startAt: true, confirmation: true },
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
  return appt;
}

/** The actor a token stands for. Honest in the trail: the client did this. */
const tokenActor = (link: { clientId: string }): Actor =>
  ({ id: link.clientId, role: 'client' });

const tokenRequest = (link: { clientId: string }, appointmentId: string, reason: string) => ({
  actor: tokenActor(link),
  action: 'update' as const,
  resource: 'appointment' as const,
  resourceId: appointmentId,
  clientId: link.clientId,
  target: { ownerClientId: link.clientId },
  // The answer, as a code. It is what lets an auditor count answers against an
  // appointment without reading anything the client sent.
  reason,
});

/**
 * Why a client cannot come, from a fixed list.
 *
 * Shared by the reschedule request and the decline: they are the same question
 * — "why not this hour" — asked by two buttons, and a parallel vocabulary for
 * the second would be two places to add a fifth reason and two things for a
 * report to union. Never free text, for the reason the whole client-facing
 * surface has none: a box on a client's page is a channel for clinical content
 * to arrive at the one desk that must never see it.
 */
/**
 * "Send me fewer of these."
 *
 * The one thing behind this door that changes something about the client rather
 * than about an appointment, and the boundary is deliberate: it may narrow the
 * cadence and it may never touch the channel. A leaked link that leaves
 * somebody on one reminder instead of three is strictly less harmful than one
 * that cancels their session, which this door already does — it stays
 * fee-eligible, it is logged with the client as the actor, and it shows on the
 * door, so a client whose link was misused can see it happened. A leaked link
 * reaching `reminderPreference: 'none'` would be a different class: the
 * messages and the fee would go quiet together, so nothing would notice.
 *
 * There is no value here meaning "stop". That is the channel, it is a safety
 * setting rather than a volume one, and asking for it is a phone call.
 */
export async function chooseCadence(
  token: string,
  cadence: ReminderCadence,
  opts: { clock?: Clock } = {},
) {
  const link = await liveLink(token, opts.clock ?? systemClock);
  return setReminderCadence(tokenActor(link), link.clientId, cadence);
}

export type RescheduleReason =
  | 'cannot_make_it' | 'need_a_different_time' | 'prefer_earlier' | 'prefer_later';

/**
 * "Yes, I am coming." One tap, and it answers the practice's question without
 * touching the practice's own record of what happened.
 *
 * `confirmation` is not `status`: a client saying yes is a communication fact,
 * and `status: 'confirmed'` is a staff-side lifecycle step somebody at the
 * front desk decided. Collapsing them is how a client who answered ends up
 * counted as having arrived.
 */
export async function confirmAppointment(
  token: string,
  appointmentId: string,
  opts: { clock?: Clock } = {},
) {
  const clock = opts.clock ?? systemClock;
  const link = await liveLink(token, clock);
  const appt = await ownAppointment(link, appointmentId, clock);

  // A second tap is the same confirmation, not a second one — the same rule as
  // an already-open reschedule request, and it keeps the audit trail a record
  // of answers rather than of taps.
  if (appt.confirmation === 'confirmed') return appt;

  return guarded(tokenRequest(link, appt.id, 'confirmed'), (tx) =>
    tx.appointment.update({ where: { id: appt.id }, data: { confirmation: 'confirmed' } }));
}

/**
 * "No, I cannot make it." Unlike the reschedule request, this one destroys
 * something — and that is deliberate (D-06): an hour the client has said they
 * will not attend has to free the room, or the whole loop is theatre.
 *
 * The money is not this function's. `cancelAppointment` decides late or
 * advance from the clock and applies the practice's existing late-cancel fee,
 * exactly as it does when front desk clicks it. All this adds is the answer
 * riding in the same write, and the second tap in front of a charge.
 */
export async function declineAppointment(
  token: string,
  appointmentId: string,
  opts: { clock?: Clock; acknowledgeFee?: boolean; reason?: RescheduleReason } = {},
) {
  const clock = opts.clock ?? systemClock;
  const link = await liveLink(token, clock);
  const appt = await ownAppointment(link, appointmentId, clock);

  const settings = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const windowHours = settings?.lateCancelWindowHours ?? 24;
  const late = classifyCancellation(appt.startAt, clock.now(), windowHours) === 'late_cancelled';

  // Inside the window the fee is a thing the client is told, not a thing they
  // discover. The interstitial names it and asks again; outside the window
  // there is nothing to disclose and nothing to ask.
  if (late && !opts.acknowledgeFee) {
    throw new Conflict(
      `Cancelling this close to the appointment is chargeable`,
      'fee_acknowledgement_required',
    );
  }

  return cancelAppointment(tokenActor(link), appt.id, {
    clock,
    // P1-5. The same four codes the reschedule request uses, rather than a
    // parallel vocabulary invented for the same question asked twice. Two of
    // them — "earlier" and "later" — read a little oddly on a cancellation,
    // and that is the smaller cost: a second list would mean two places to add
    // a fifth reason, two things for a report to union, and a client answering
    // the same question with different words depending on which button they
    // reached it from. A decline with no reason stays legal, because a keyword
    // reply carries none.
    reason: opts.reason ?? 'client declined',
    confirmation: 'declined',
  });
}

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
  await ownAppointment(link, appointmentId, clock);

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
