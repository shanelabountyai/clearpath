import { randomUUID } from 'node:crypto';
import { auditEvent, auditEvents, guarded, guardedAll, may } from '../auth/guard';
import type { Actor, Role } from '../auth/permissions';
import { DAY, systemClock, type Clock } from '../clock';
import { prisma, type Tx } from '../db';
import { Conflict, NotFound } from '../errors';
import { clientUrl, queueToClient } from '../messaging/outbox';
import { ensurePortalLink } from '../portal/service';
import { conflictKind } from '../scheduling/booking';
import { TRANSITIONS as SESSION_TRANSITIONS, type Status as SessionStatus } from '../scheduling/lifecycle';
import { SYSTEM_ACTOR } from '../scheduling/reminders';
import { daysBetween, localDateOf, zonedToUtc, type LocalDate } from '../time';
import { ROUTED_CLIENT, routesOf, type RoutedClient } from './coverage';

/**
 * A departure is a plan before it is an event.
 *
 * `planned` is recorded on notice and does two things immediately — closes the
 * clinician's books and marks them departing in the person picker. Everything
 * else waits for `executed`, which is a second, separate act on the last day.
 * That gap is the whole design: it is the thirty days the practice has to
 * decide fifteen dispositions and clear the hour clashes, and it is why
 * `cancelled` is cheap — withdrawing a notice reverses two flags, because
 * nothing else has happened yet.
 */
export type DepartureStatus = 'planned' | 'executed' | 'cancelled';

/**
 * Both endings are terminal, in the register `scheduling/lifecycle.ts` set.
 *
 * Nothing returns to `planned`. A departure that executed moved a caseload,
 * abandoned drafts and deactivated an account; a re-plan is a new row, the same
 * way the correction for a signed note is an amendment and not an edit. A
 * cancelled notice that is given again is genuinely a second notice, on a
 * second date, and the audit log should show two.
 */
export const TRANSITIONS: Record<DepartureStatus, readonly DepartureStatus[]> = {
  planned: ['executed', 'cancelled'],
  executed: [],
  cancelled: [],
};

export const canTransition = (from: DepartureStatus, to: DepartureStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** A wrong transition is a refusal, never a silent no-op. */
export function assertTransition(from: DepartureStatus, to: DepartureStatus): void {
  if (!canTransition(from, to)) {
    throw new Conflict(`A ${from} departure cannot become ${to}`, 'bad_transition');
  }
}

/** The destruction window, read in one place so the sweep and its preview cannot disagree. */
const processNoteWindowDays = async () =>
  (await prisma.practiceSettings.findUnique({ where: { id: 1 }, select: { processNoteAfterDepartureDays: true } }))
    ?.processNoteAfterDepartureDays ?? 2555;

/**
 * P0-10: destroy the process notes of a clinician who left, once the window
 * has passed.
 *
 * The two-step is the same one the intake purge makes (D-03), for the same
 * reason: a mis-executed departure on Tuesday is recoverable on Wednesday, and
 * a destruction driven by the injected clock is a destruction that can be
 * tested. What is different here is the sensitivity — this is the only table
 * in the schema with exactly one reader — so the window is `processNoteAfter\
 * DepartureDays`, ships at seven years, and the settings page says the number
 * is a professional and jurisdictional question rather than an engineering one.
 *
 * Driven from the executed departures rather than from the notes: it is the
 * only query shape that can name `authorId` in the SQL, which is hard rule 2
 * and is asserted structurally by `notes/service.test.ts`. It also means the
 * sweep can never reach a note whose author is still here, whatever
 * `unreachableSince` happens to say — and the database refuses that row a
 * second time, in `process_note_delete_only_after_departure`.
 *
 * `auditEvent`, not `guarded`, and that is the point rather than a shortcut:
 * there is no cell in the matrix that lets anybody but the author touch a
 * process note, `SYSTEM_ACTOR` included, and inventing one so a sweep could
 * pass through the front door would be the widening this whole feature exists
 * to refuse. A retention window expiring is not an actor exercising a power.
 * The row still lands in the same transaction as the deletion, per hard rule 4,
 * carrying ids and a reason code and nothing else.
 */
export async function runProcessNotePurge(clock: Clock = systemClock): Promise<string[]> {
  const cutoff = new Date(clock.now().getTime() - (await processNoteWindowDays()) * DAY);

  const departures = await prisma.departure.findMany({
    where: { status: 'executed' },
    select: { id: true, userId: true },
  });

  const destroyed: string[] = [];
  for (const departure of departures) {
    // Ids and the client only. The sweep never selects `content`, which is the
    // difference between destroying a private note and reading one on the way.
    const due = await prisma.processNote.findMany({
      where: { authorId: departure.userId, unreachableSince: { lte: cutoff } },
      select: { id: true, clientId: true },
    });

    for (const note of due) {
      await prisma.$transaction(async (tx) => {
        // Amendments go with it, in the same statement, by `ON DELETE CASCADE`
        // — an amendment carries its own content, so leaving it behind would
        // destroy the row and keep the text.
        await tx.processNote.deleteMany({
          where: { id: note.id, authorId: departure.userId },
        });
        await auditEvent(
          SYSTEM_ACTOR,
          'discard',
          'process_note',
          { resourceId: note.id, clientId: note.clientId, reason: 'departure:process_note_destroyed' },
          tx,
        );
      });
      destroyed.push(note.id);
    }
  }
  return destroyed;
}

/**
 * P1-5: what the sweep will destroy and when, before it fires — the intake
 * PRD's P1-4, for the most sensitive table in the schema.
 *
 * Counts and dates per departure, never a client and never a line of content.
 * The only person who could read these notes has left, and a preview listing
 * which clients they wrote privately about would tell the practice manager
 * something the author never did. On `departure.read`, because no cell anywhere
 * lets anybody but the author near a process note, and this reads a
 * departure's consequences rather than the notes (D-29). Same window and the
 * same author-keyed query as `runProcessNotePurge`, so the two cannot disagree
 * about what is due.
 */
export async function previewProcessNotePurge(actor: Actor, clock: Clock = systemClock) {
  const days = await processNoteWindowDays();
  const cutoff = new Date(clock.now().getTime() - days * DAY);

  return guarded({ actor, action: 'read', resource: 'departure' }, async (tx) => {
    const departures = await tx.departure.findMany({
      where: { status: 'executed' },
      select: { id: true, userId: true, user: { select: { name: true } } },
      orderBy: { executedAt: 'asc' },
    });
    const rows = await Promise.all(departures.map(async (d) => {
      const [held, dueNow] = await Promise.all([
        tx.processNote.aggregate({
          where: { authorId: d.userId, unreachableSince: { not: null } },
          _count: true,
          _min: { unreachableSince: true },
        }),
        tx.processNote.count({ where: { authorId: d.userId, unreachableSince: { lte: cutoff } } }),
      ]);
      const since = held._min.unreachableSince;
      return {
        departureId: d.id, name: d.user.name, notes: held._count, dueNow,
        destroyedFrom: since && new Date(since.getTime() + days * DAY),
      };
    }));
    return rows.filter((r) => r.notes > 0);
  });
}

// ─────────────────── who a plan may name (hard rule 1) ───────────────────

/**
 * Could this person carry a client? Asked of the matrix rather than of a role
 * name: treating somebody is writing their record, so the question is whether
 * the matrix would let them write a note for a client of their own.
 */
export const mayTreat = (u: { id: string; role: Role }) => may({
  actor: { id: u.id, role: u.role }, action: 'create', resource: 'progress_note',
  target: { clinicianId: u.id },
});

/**
 * Could this person take a departing supervisor's associates? A receiver the
 * matrix would never let co-sign leaves every associate with a co-signature
 * nobody can give (P0-8). Asked of the matrix, so it stays right if who may
 * co-sign ever changes.
 */
export const maySupervise = (u: { id: string; role: Role }) => may({
  actor: { id: u.id, role: u.role }, action: 'cosign', resource: 'progress_note',
  target: { authorSupervisorId: u.id },
});

/** The caseload a departure is about: who the leaver treats today, not who they treated when the plan was made. */
const caseloadOf = (userId: string) => ({ treatingClinicianId: userId, status: 'active' as const });

// ─────────────────────── the two moments (P0-9) ───────────────────────

/**
 * Notice: record the plan, and close the clinician's books the same afternoon.
 *
 * `acceptingNewClients = false` is the one narrow path by which anybody but
 * the clinician touches capacity (D-10), and it only ever closes. The value it
 * overwrote is kept on the row, because withdrawn notice restores a fact
 * rather than inventing one — see `cancelDeparture`.
 *
 * Nothing else moves. The clinician keeps working, keeps signing, and keeps
 * their calendar until the last day; that gap is what `planned` is for.
 */
export async function planDeparture(
  actor: Actor,
  input: { userId: string; lastDayOn: LocalDate; receivingSupervisorId?: string },
  clock: Clock = systemClock,
) {
  const leaver = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { acceptingNewClients: true },
  });
  if (!leaver) throw new NotFound('User');
  // String order is date order for ISO dates. The CHECK refuses it too; this is
  // the sentence a person sees instead of a constraint name.
  if (!(input.lastDayOn >= localDateOf(clock.now()))) {
    throw new Conflict('A last day cannot be before the notice', 'last_day_past');
  }

  // Decided here for the reason `convertInquiry` decides its client id: the
  // audit row names the departure, and a row that does not exist yet cannot be
  // named.
  const id = randomUUID();
  try {
    return await guarded(
      {
        actor, action: 'create', resource: 'departure', resourceId: id,
        target: { subjectUserId: input.userId },
      },
      async (tx) => {
        const departure = await tx.departure.create({
          data: {
            id,
            userId: input.userId,
            plannedById: actor.id,
            noticeAt: clock.now(),
            lastDayOn: new Date(`${input.lastDayOn}T00:00:00Z`),
            receivingSupervisorId: input.receivingSupervisorId ?? null,
            acceptingNewClientsAtNotice: leaver.acceptingNewClients,
          },
        });
        await tx.user.update({ where: { id: input.userId }, data: { acceptingNewClients: false } });
        return departure;
      },
      );
  } catch (e) {
    // The partial unique index decides, not a pre-check: two people recording
    // the same notice at once is a race a read would lose.
    if ((e as { code?: unknown }).code === 'P2002') {
      throw new Conflict('This person already has a departure planned', 'already_departing');
    }
    throw e;
  }
}

/**
 * Withdrawn notice reverses what notice did, and nothing else — because
 * nothing else has happened yet. That is the whole reason execution is a
 * separate act.
 *
 * `update`, not `depart`: a supervisor may withdraw a plan they may amend, and
 * cancelling deactivates nobody.
 */
export async function cancelDeparture(actor: Actor, departureId: string) {
  const departure = await prisma.departure.findUnique({
    where: { id: departureId },
    select: { status: true, userId: true, acceptingNewClientsAtNotice: true },
  });
  if (!departure) throw new NotFound('Departure');
  assertTransition(departure.status, 'cancelled');

  return guarded(
    {
      actor, action: 'update', resource: 'departure', resourceId: departureId,
      target: { subjectUserId: departure.userId }, reason: 'departure:cancelled',
    },
    async (tx) => {
      await tx.user.update({
        where: { id: departure.userId },
        data: { acceptingNewClients: departure.acceptingNewClientsAtNotice },
      });
      return tx.departure.update({ where: { id: departureId }, data: { status: 'cancelled' } });
    },
  );
}

// ─────────────────── is this plan ready? (P0-6, P0-7, P0-8) ───────────────────

/**
 * Everything that would stop a departure from executing, as ids.
 *
 * One list rather than the PRD's `departureConflicts`, which named only the
 * hour clashes (D-20). P0-7 and P0-8 each add a blocking item of their own, and
 * a plan screen asking four functions whether it is ready is a plan screen
 * that will one day ask three.
 *
 * No names and no content. An `unread_alert` says a risk alert exists for a
 * client and nothing about why — the plan screen resolves the client through
 * the client resource, and the alert stays readable only by its recipient.
 */
export type DepartureBlocker =
  /** On the active caseload with no disposition. Goal 2: no silent remainder. */
  | { kind: 'undecided'; clientId: string }
  /** A transfer to the leaver themselves, or to somebody no longer here. */
  | { kind: 'receiver_unavailable'; clientId: string; receivingClinicianId: string }
  /** A session that would land on an hour the receiver already holds. */
  | {
      kind: 'hour_clash'; clientId: string; appointmentId: string; startAt: Date;
      receivingClinicianId: string; collidesWithId: string;
    }
  /** An unread alert on a client nobody receives, and no supervisor to route it to. */
  | { kind: 'unread_alert'; clientId: string; alertId: string }
  /** A departing supervisor's associate, with no active supervisor named to take them. */
  | { kind: 'supervisee_unassigned'; superviseeId: string }
  /**
   * A leave of the leaver's that has not ended (leave P0-8, D-09). Two plans
   * moving one caseload on overlapping days is a half-moved state; ending the
   * leave early, or cancelling it, is one edit.
   */
  | { kind: 'leave_open'; leaveId: string };

/** Sessions that have not happened yet. Derived, so a new status cannot be forgotten here. */
const OPEN_SESSIONS = (Object.keys(SESSION_TRANSITIONS) as SessionStatus[])
  .filter((s) => SESSION_TRANSITIONS[s].length > 0);

/** Practice-local midnight at the start of the last day. */
const lastDayStart = (lastDayOn: Date) => zonedToUtc(lastDayOn.toISOString().slice(0, 10), 0);

type DepartureRow = {
  id: string; userId: string; lastDayOn: Date; receivingSupervisorId: string | null;
};

/**
 * A client's routing facts as they will stand once this departure commits: a
 * transfer's receiver treats them, the leaver is closed with their own
 * supervisor above them, and anyone the leaver supervised answers to the
 * receiving supervisor. What the blocker scan routes against, thirty days
 * before any of it is written.
 */
function afterDeparture(
  d: DepartureRow,
  leaverSupervisorId: string | null,
  c: RoutedClient,
  receiverId: string | null | undefined,
): RoutedClient {
  if (receiverId) {
    return { ...c, treatingClinicianId: receiverId, treatingClinician: { active: true, supervisorId: null } };
  }
  if (c.treatingClinicianId === d.userId) {
    return { ...c, treatingClinician: { active: false, supervisorId: leaverSupervisorId } };
  }
  if (c.treatingClinician.supervisorId === d.userId) {
    return { ...c, treatingClinician: { ...c.treatingClinician, supervisorId: d.receivingSupervisorId } };
  }
  return c;
}

/**
 * A route that names nobody: the leaver, who is closing, or the client's own
 * treating clinician once they have departed — `ownerOf`'s last resort when
 * there is no supervisor above them.
 */
const strands = (leaverId: string, c: RoutedClient, recipientId: string) =>
  recipientId === leaverId || (recipientId === c.treatingClinicianId && !c.treatingClinician.active);

async function blockersOf(db: Tx | typeof prisma, d: DepartureRow, today: LocalDate): Promise<DepartureBlocker[]> {
  const from = lastDayStart(d.lastDayOn);
  const [leaver, caseload, assignments, alerts, supervisees, receivingSupervisor, leaves] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: d.userId }, select: { supervisorId: true } }),
    db.client.findMany({ where: caseloadOf(d.userId), select: { id: true } }),
    db.departureAssignment.findMany({
      where: { departureId: d.id, client: caseloadOf(d.userId) },
      select: {
        clientId: true, disposition: true, receivingClinicianId: true,
        receivingClinician: { select: { active: true, role: true } },
      },
    }),
    db.alert.findMany({
      where: { recipientId: d.userId, acknowledgedAt: null },
      select: { id: true, clientId: true, client: { select: ROUTED_CLIENT } },
    }),
    db.user.findMany({ where: { supervisorId: d.userId }, select: { id: true } }),
    d.receivingSupervisorId
      ? db.user.findUnique({ where: { id: d.receivingSupervisorId }, select: { id: true, role: true, active: true } })
      : null,
    // Upcoming or active: not cancelled, and the last day not yet behind us.
    db.leave.findMany({
      where: { userId: d.userId, cancelledAt: null, toDate: { gte: new Date(`${today}T00:00:00Z`) } },
      select: { id: true },
    }),
  ]);

  const decided = new Map(assignments.map((a) => [a.clientId, a]));
  const blockers: DepartureBlocker[] = [];

  for (const c of caseload) {
    if (!decided.has(c.id)) blockers.push({ kind: 'undecided', clientId: c.id });
  }
  for (const a of assignments) {
    const r = a.receivingClinician;
    if (a.receivingClinicianId && (
      a.receivingClinicianId === d.userId || !r?.active || !mayTreat({ id: a.receivingClinicianId, role: r.role })
    )) {
      blockers.push({ kind: 'receiver_unavailable', clientId: a.clientId, receivingClinicianId: a.receivingClinicianId });
    }
  }
  // P0-7: an unread risk alert is not something a departure gets to close over.
  // Ask routing where each would go once this commits — a transfer's receiver,
  // the leaver's supervisor, a departed supervisee's new supervisor, or a cover
  // (D-31). A route that names nobody is the blocker — `strands` says which.
  if (alerts.length) {
    const after = new Map(alerts.map((a) =>
      [a.clientId, afterDeparture(d, leaver.supervisorId, a.client, decided.get(a.clientId)?.receivingClinicianId)]));
    const routes = await routesOf(db, [...after.values()], today);
    for (const alert of alerts) {
      const c = after.get(alert.clientId)!;
      if (strands(d.userId, c, routes.get(alert.clientId)!.recipientId)) {
        blockers.push({ kind: 'unread_alert', clientId: alert.clientId, alertId: alert.id });
      }
    }
  }
  // P0-8: associates need somebody who can co-sign for them.
  const receiverCanSupervise = !!receivingSupervisor?.active && maySupervise(receivingSupervisor);
  if (!receiverCanSupervise) {
    for (const s of supervisees) blockers.push({ kind: 'supervisee_unassigned', superviseeId: s.id });
  }

  // The same question `appointment_clinician_no_overlap` asks, in the same
  // operator, so the preview and the constraint cannot disagree about what a
  // clash is. The constraint still decides at execution; this is the thirty
  // days' warning.
  const clashes = await db.$queryRaw<Omit<Extract<DepartureBlocker, { kind: 'hour_clash' }>, 'kind'>[]>`
    SELECT m.id AS "appointmentId", m."clientId", m."startAt",
           a."receivingClinicianId", o.id AS "collidesWithId"
    FROM "Appointment" m
    JOIN "DepartureAssignment" a
      ON a."clientId" = m."clientId" AND a."departureId" = ${d.id} AND a.disposition = 'transfer'
    JOIN "Appointment" o
      ON o."clinicianId" = a."receivingClinicianId"
     AND o.status NOT IN ('cancelled', 'late_cancelled')
     AND tstzrange(o."startAt", o."endAt", '[)') && tstzrange(m."startAt", m."endAt", '[)')
    WHERE m."clinicianId" = ${d.userId}
      AND m."startAt" >= ${from}
      AND m.status::text = ANY(${OPEN_SESSIONS})
    ORDER BY m."startAt"
  `;
  for (const c of clashes) blockers.push({ kind: 'hour_clash', ...c });
  for (const l of leaves) blockers.push({ kind: 'leave_open', leaveId: l.id });

  return blockers;
}

const DEPARTURE_ROW = { id: true, userId: true, lastDayOn: true, receivingSupervisorId: true, status: true } as const;

/** The plan screen's answer to "is this departure ready?" Read-guarded, because it names clients. */
export async function departureBlockers(actor: Actor, departureId: string, clock: Clock = systemClock) {
  const d = await prisma.departure.findUnique({ where: { id: departureId }, select: DEPARTURE_ROW });
  if (!d) throw new NotFound('Departure');
  return guarded(
    { actor, action: 'read', resource: 'departure', resourceId: departureId, target: { subjectUserId: d.userId } },
    (tx) => blockersOf(tx, d, localDateOf(clock.now())),
  );
}

// ─────────────────────── the decisions (P0-1, P0-11) ───────────────────────

export type Disposition = 'transfer' | 'discharge' | 'referred_out';

/** A plan changes while it is a plan, and never after. */
async function plannedRow(departureId: string) {
  const d = await prisma.departure.findUnique({ where: { id: departureId }, select: { status: true, userId: true } });
  if (!d) throw new NotFound('Departure');
  if (d.status !== 'planned') throw new Conflict(`A ${d.status} departure cannot be changed`, 'bad_transition');
  return d;
}

/**
 * One client, one decision — and the only writer of `DepartureAssignment`.
 *
 * `departure.update`, so a supervisor may propose and the practice manager may
 * decide; front desk reads the answer and cannot write it. Deciding again
 * replaces the decision rather than stacking a second, and every decision is
 * its own audit row naming the client and the disposition as a code (P0-11),
 * so the log still shows the one it replaced.
 *
 * Refused inside the guard, so a caller the matrix turns away learns nothing
 * about the caseload:
 * - a client not on the leaver's active caseload. Execution repoints what it is
 *   handed, so a decision about somebody else's client is a transfer of a
 *   record this plan was never about;
 * - a transfer to nobody, or to somebody who could not carry the client — the
 *   leaver, a colleague who has gone, a role the matrix would never let write a
 *   note. The picker only offers clinicians; a hand-rolled POST is why this
 *   asks anyway.
 *
 * Fields that do not belong to the disposition are dropped rather than refused,
 * the way `createInquiry` drops a referrer on a non-GP source: a form cannot
 * hide a select without JavaScript, and the CHECK refuses the row that disagrees.
 */
export async function decideAssignment(
  actor: Actor,
  departureId: string,
  input: {
    clientId: string; disposition: Disposition;
    receivingClinicianId?: string | null; referredOutToId?: string | null;
  },
  clock: Clock = systemClock,
) {
  const d = await plannedRow(departureId);
  const { clientId, disposition } = input;

  return guarded(
    {
      actor, action: 'update', resource: 'departure', resourceId: departureId, clientId,
      target: { subjectUserId: d.userId }, reason: `departure:decided_${disposition}`,
    },
    async (tx) => {
      if (!(await tx.client.count({ where: { id: clientId, ...caseloadOf(d.userId) } }))) {
        throw new Conflict('That client is not on this caseload', 'not_on_caseload');
      }

      const receivingClinicianId = disposition === 'transfer' ? input.receivingClinicianId || null : null;
      if (disposition === 'transfer') {
        const receiver = receivingClinicianId
          ? await tx.user.findUnique({ where: { id: receivingClinicianId }, select: { id: true, role: true, active: true } })
          : null;
        if (!receiver?.active || receiver.id === d.userId || !mayTreat(receiver)) {
          throw new Conflict('A transfer needs a clinician who is staying', 'receiver_unavailable');
        }
      }

      const decision = {
        disposition,
        receivingClinicianId,
        referredOutToId: disposition === 'referred_out' ? input.referredOutToId || null : null,
        decidedById: actor.id,
        decidedAt: clock.now(),
      };
      return tx.departureAssignment.upsert({
        where: { departureId_clientId: { departureId, clientId } },
        create: { departureId, clientId, ...decision },
        update: decision,
      });
    },
  );
}

/**
 * Name who takes a departing supervisor's associates, or nobody (P0-8).
 *
 * Its own act because `supervisee_unassigned` is a blocker the plan screen
 * shows, and a blocker whose only fix is withdrawing notice and giving it again
 * puts two notices in the log for one decision. The test the blocker scan
 * applies, applied at the door.
 */
export async function setReceivingSupervisor(actor: Actor, departureId: string, supervisorId: string | null) {
  const d = await plannedRow(departureId);
  return guarded(
    {
      actor, action: 'update', resource: 'departure', resourceId: departureId,
      target: { subjectUserId: d.userId }, reason: 'departure:receiving_supervisor',
    },
    async (tx) => {
      if (supervisorId) {
        const s = await tx.user.findUnique({ where: { id: supervisorId }, select: { id: true, role: true, active: true } });
        if (!s?.active || s.id === d.userId || !maySupervise(s)) {
          throw new Conflict('The receiving supervisor must be a supervisor who is staying', 'receiver_unavailable');
        }
      }
      return tx.departure.update({ where: { id: departureId }, data: { receivingSupervisorId: supervisorId } });
    },
  );
}

// ─────────────────────────── the screens (Phase 4) ───────────────────────────

/** Every departure, open ones first. Front desk, supervisors and the practice manager. */
export async function listDepartures(actor: Actor) {
  return guarded({ actor, action: 'read', resource: 'departure' }, (tx) =>
    tx.departure.findMany({
      select: { id: true, status: true, noticeAt: true, lastDayOn: true, user: { select: { name: true } } },
      orderBy: [{ status: 'asc' }, { lastDayOn: 'asc' }],
    }));
}

/**
 * P1-1: the open plans, and what still stands between each one and its last
 * day — the line on the work-lists page that says which plan to open.
 *
 * Not a second readiness screen. The plan screen is that, and it is where
 * clients are named; this returns counts, so no client id leaves the function
 * and nothing on a shared page can name one (D-25, applied to the whole list).
 * Unsigned notes are counted beside the blockers rather than among them: they
 * never stop an execution, they become notes nobody may sign (P0-4b), and the
 * days left are the point (D-28).
 */
export async function departureWorklist(actor: Actor, clock: Clock = systemClock) {
  const today = localDateOf(clock.now());
  return guarded({ actor, action: 'read', resource: 'departure' }, async (tx) => {
    const open = await tx.departure.findMany({
      where: { status: 'planned' },
      select: { ...DEPARTURE_ROW, user: { select: { name: true } } },
      orderBy: { lastDayOn: 'asc' },
    });
    return Promise.all(open.map(async (d) => {
      const [blockers, unsignedNotes] = await Promise.all([
        blockersOf(tx, d, today),
        tx.progressNote.count({ where: { authorId: d.userId, status: 'draft' } }),
      ]);
      const blocking: Partial<Record<DepartureBlocker['kind'], number>> = {};
      for (const b of blockers) blocking[b.kind] = (blocking[b.kind] ?? 0) + 1;
      return {
        id: d.id, name: d.user.name, lastDayOn: d.lastDayOn,
        daysLeft: daysBetween(today, d.lastDayOn.toISOString().slice(0, 10)),
        blocking, unsignedNotes,
      };
    }));
  });
}

/**
 * P1-4: how many sessions each departure left with no signed note.
 *
 * The only honest measure of whether showing a leaver their drafts (P0-4a)
 * works, and a practice that cannot see the number will not fix it. A count by
 * departure on `departure.read`: the practice manager holds `progress_note.read`
 * only under break-glass, and a number about a colleague leaving is not a read
 * of anybody's record. Departures that left none are listed too — zero is the
 * result worth seeing.
 */
export async function abandonedNotesByDeparture(actor: Actor) {
  const rows = await guarded({ actor, action: 'read', resource: 'departure' }, (tx) =>
    tx.departure.findMany({
      where: { status: 'executed' },
      select: { id: true, lastDayOn: true, user: { select: { name: true } }, _count: { select: { abandoned: true } } },
      orderBy: { lastDayOn: 'desc' },
    }));
  return rows.map((d) => ({ id: d.id, name: d.user.name, lastDayOn: d.lastDayOn, abandoned: d._count.abandoned }));
}

const CLIENT_NAME = { id: true, code: true, firstName: true, lastName: true } as const;

/**
 * The plan screen, in one read and one audit row.
 *
 * Client names ride on `departure.read`, not `client.read`, where the practice
 * manager holds only break-glass. A plan is a client list, and a client list at
 * the demographic tier is what P0-3 gave this cell — the tier the calendar
 * already shows the practice manager through `appointment.read` (D-24). Names
 * and codes and nothing else: no date of birth, no contact details, nothing a
 * caseload decision does not need.
 *
 * Blockers come back as ids, as `blockersOf` makes them, and the screen labels
 * them from `clients`. Once executed the caseload belongs to other people, so
 * the list is what the plan decided.
 */
export async function getDeparturePlan(actor: Actor, departureId: string, clock: Clock = systemClock) {
  const d = await prisma.departure.findUnique({ where: { id: departureId }, select: DEPARTURE_ROW });
  if (!d) throw new NotFound('Departure');

  return guarded(
    { actor, action: 'read', resource: 'departure', resourceId: departureId, target: { subjectUserId: d.userId } },
    async (tx) => {
      const [detail, caseload, assignments, blockers] = await Promise.all([
        tx.departure.findUniqueOrThrow({
          where: { id: departureId },
          select: {
            noticeAt: true, executedAt: true,
            user: { select: { name: true } },
            plannedBy: { select: { name: true } },
            receivingSupervisor: { select: { id: true, name: true } },
          },
        }),
        tx.client.findMany({ where: caseloadOf(d.userId), select: CLIENT_NAME }),
        tx.departureAssignment.findMany({
          where: { departureId },
          select: {
            clientId: true, disposition: true, receivingClinicianId: true, referredOutToId: true, decidedAt: true,
            client: { select: CLIENT_NAME },
            receivingClinician: { select: { name: true } },
            referredOutTo: { select: { practice: true } },
            decidedBy: { select: { name: true } },
          },
        }),
        d.status === 'planned' ? blockersOf(tx, d, localDateOf(clock.now())) : Promise.resolve([] as DepartureBlocker[]),
      ]);

      const decided = new Map(assignments.map((a) => [a.clientId, a]));
      const clients = (d.status === 'executed' ? assignments.map((a) => a.client) : caseload)
        .sort((a, b) => a.lastName.localeCompare(b.lastName))
        .map((c) => ({ ...c, assignment: decided.get(c.id) ?? null }));
      return { ...d, ...detail, clients, blockers };
    },
  );
}

/**
 * P0-4a: a departing clinician's own unsigned drafts, oldest first, with the
 * days left to sign them — the half of this feature that prevents the hole
 * rather than labelling it (D-03).
 *
 * Null for anybody not leaving, and for anybody who writes no notes. Two rows
 * through `guardedAll`: the departure under `self`, the drafts under the
 * `progress_note.read` an author already holds. No new cell.
 */
export async function ownDrafts(actor: Actor, clock: Clock = systemClock) {
  const d = await prisma.departure.findFirst({
    where: { userId: actor.id, status: 'planned' },
    select: { id: true, lastDayOn: true },
  });
  if (!d || !mayTreat(actor)) return null;

  return guardedAll(
    [
      { actor, action: 'read', resource: 'departure', resourceId: d.id, target: { subjectUserId: actor.id } },
      { actor, action: 'read', resource: 'progress_note', target: { authorId: actor.id } },
    ],
    async (tx) => ({
      daysLeft: daysBetween(localDateOf(clock.now()), d.lastDayOn.toISOString().slice(0, 10)),
      drafts: await tx.progressNote.findMany({
        where: { authorId: actor.id, status: 'draft' },
        select: {
          id: true, createdAt: true,
          client: { select: CLIENT_NAME },
          appointment: { select: { startAt: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    }),
  );
}

// ─────────────────────── the transaction (P0-6) ───────────────────────

/**
 * Execute a departure: move the caseload, close the drafts, end the account.
 * Everything, or nothing.
 *
 * A partially moved caseload — some clients with a new clinician, some with a
 * deactivated one, a supervision tree half repointed — is the worst state this
 * feature can produce, and worse than not executing. So there is one
 * transaction, and every write below either commits with the others or rolls
 * back with them.
 *
 * **Hour clashes are decided by Postgres, not by a pre-check.** `booking.ts`
 * learned this the expensive way: a read-then-write check has a window, and a
 * session booked onto the receiver between the check and the move would slip
 * through it. `appointment_clinician_no_overlap` refuses the repoint, the whole
 * departure rolls back, and the caller gets a `Conflict`. `departureBlockers`
 * is the preview; the constraint is the lock.
 *
 * The other blockers are checked inside the transaction and refuse before any
 * write, because they are facts about the plan rather than races with a
 * neighbour. The date answers first (D-30): before the last day nothing
 * executes, whatever else the plan still needs.
 *
 * **One `guarded` row, and `auditEvent` for everything it caused (D-21).** The
 * PRD sketched `guardedAll` over the records touched, and the matrix refuses
 * it: admin's `client.update` is `breakGlass`, and a departure has no
 * break-glass cell by design. Granting admin `client.update` so the transfer
 * could pass through the per-record door would be exactly the widening this
 * feature exists to refuse. `depart` is the power that was exercised and it is
 * decided once; the rows after it are its consequences, each naming the
 * departure, the client where there is one, and a code — P0-11's shape.
 */
export async function executeDeparture(actor: Actor, departureId: string, clock: Clock = systemClock) {
  const d = await prisma.departure.findUnique({ where: { id: departureId }, select: DEPARTURE_ROW });
  if (!d) throw new NotFound('Departure');
  assertTransition(d.status, 'executed');

  const now = clock.now();
  const from = lastDayStart(d.lastDayOn);
  const note = (tx: Tx, reason: string, clientId?: string) =>
    auditEvent(actor, 'depart', 'departure', { resourceId: d.id, clientId, reason, rule: 'departure' }, tx);
  // The same row, one per member of a list whose length this feature does not
  // bound. See `auditEvents` for why that distinction is worth two helpers.
  const notes = (tx: Tx, reason: string, clientIds: readonly (string | undefined)[]) =>
    auditEvents(actor, 'depart', 'departure',
      clientIds.map((clientId) => ({ resourceId: d.id, clientId, reason, rule: 'departure' })), tx);

  try {
    // 30s. What could spend it is not the caseload — that is bounded by the
    // active clients, measured at ~1.8ms each — but the two lists that grow
    // with a career: the abandoned drafts and the unreachable process notes,
    // one audit row apiece. Those log through `auditEvents`, which is where
    // the measurement is written down. Everything else here is per-caseload.
    return await prisma.$transaction((tx) => guarded(
      {
        actor, action: 'depart', resource: 'departure', resourceId: d.id,
        target: { subjectUserId: d.userId },
      },
      async (tx) => {
        // D-30. Sessions move from the last day on and the account closes
        // whenever this runs, so an early click would leave the weeks between
        // on somebody who can no longer sign in. Inside the guard, so a
        // supervisor's early attempt is still a denial on the record.
        if (localDateOf(now) < d.lastDayOn.toISOString().slice(0, 10)) {
          throw new Conflict('A departure cannot execute before its last day', 'before_last_day');
        }
        const blockers = (await blockersOf(tx, d, localDateOf(now))).filter((b) => b.kind !== 'hour_clash');
        if (blockers.some((b) => b.kind === 'leave_open')) {
          throw new Conflict('This person has a leave that has not ended. End or cancel it first', 'leave_open');
        }
        if (blockers.length) {
          throw new Conflict(`This departure has ${blockers.length} unresolved item(s)`, 'departure_not_ready');
        }

        // A decision about a client front desk has since given to somebody
        // else is a decision about nobody on this caseload. Repointing it would
        // take the client from their new clinician; skipping it takes nothing.
        const assignments = await tx.departureAssignment.findMany({
          where: { departureId: d.id, client: caseloadOf(d.userId) },
          select: {
            clientId: true, disposition: true, receivingClinicianId: true,
            client: { select: { reminderPreference: true } },
          },
          // In the order they were decided, so the audit rows read the way the plan was made.
          orderBy: { decidedAt: 'asc' },
        });

        for (const a of assignments) {
          const future = { clientId: a.clientId, clinicianId: d.userId, startAt: { gte: from }, status: { in: OPEN_SESSIONS } };
          const receiver = a.receivingClinicianId;

          if (receiver) {
            const firstMoved = await tx.appointment.findFirst({
              where: future, orderBy: { startAt: 'asc' }, select: { startAt: true },
            });
            await tx.client.update({ where: { id: a.clientId }, data: { treatingClinicianId: receiver } });
            // The write the exclusion constraint may refuse — after the client
            // row on purpose, so a clash proves the rollback rather than
            // preceding every write.
            await tx.appointment.updateMany({ where: future, data: { clinicianId: receiver } });
            await tx.appointmentSeries.updateMany({
              where: { clientId: a.clientId, clinicianId: d.userId, active: true },
              data: { clinicianId: receiver },
            });
            // P1-3. Queued, never sent, so it commits or rolls back with the
            // move it describes. Only a client with a session that moved has a
            // schedule to be told about, and `none` means none — not even a
            // door minted for a message that will never go (D-27).
            if (firstMoved && a.client.reminderPreference !== 'none') {
              const door = await ensurePortalLink(a.clientId, clock, tx);
              await queueToClient({
                clientId: a.clientId, templateKey: 'clinician_changed', scheduledFor: now,
                startAt: firstMoved.startAt, link: clientUrl(`/p/${door.token}`),
              }, tx);
            }
          } else {
            await tx.client.update({ where: { id: a.clientId }, data: { status: 'inactive' } });
            await tx.appointment.updateMany({
              where: future,
              data: { status: 'cancelled', cancelledAt: now, cancelledById: actor.id, cancelReason: 'clinician departed' },
            });
            await tx.appointmentSeries.updateMany({
              where: { clientId: a.clientId, clinicianId: d.userId, active: true },
              data: { active: false },
            });
          }

          await note(tx, `departure:${a.disposition}`, a.clientId);
        }

        // P0-8. Supervision is data: repointing this reroutes co-signature and
        // note access at read time, with no deploy — the promise on the column.
        const supervisees = await tx.user.findMany({ where: { supervisorId: d.userId }, select: { id: true } });
        if (supervisees.length) {
          await tx.user.updateMany({ where: { supervisorId: d.userId }, data: { supervisorId: d.receivingSupervisorId } });
          for (const _ of supervisees) await note(tx, 'departure:supervisor_repointed');
        }

        // P0-4b. `sign` stays `author`; the drafts become what they are.
        const drafts = await tx.progressNote.findMany({
          where: { authorId: d.userId, status: 'draft' },
          select: { clientId: true },
        });
        await tx.progressNote.updateMany({
          where: { authorId: d.userId, status: 'draft' },
          data: { status: 'abandoned', abandonedByDepartureId: d.id },
        });
        await notes(tx, 'departure:note_abandoned', drafts.map((n) => n.clientId));

        // P0-10. Records *when* the only reader stopped existing, and grants
        // nobody anything. Ids and the client only — never `content`.
        const unreachable = await tx.processNote.findMany({
          where: { authorId: d.userId, unreachableSince: null },
          select: { clientId: true },
        });
        await tx.processNote.updateMany({
          where: { authorId: d.userId, unreachableSince: null },
          data: { unreachableSince: now },
        });
        await notes(tx, 'departure:process_note_unreachable', unreachable.map((n) => n.clientId));

        await tx.user.update({ where: { id: d.userId }, data: { active: false } });
        await note(tx, 'departure:deactivated');

        // P0-7. Acknowledged alerts stay where they are: "Alex saw this on the
        // 12th" is a fact about the 12th. Every unread one the leaver still
        // holds moves, in one pass after the writes above rather than per
        // client, because the ones this missed are the ones about somebody
        // else's client: a departed supervisee's, handed here by P0-7 (D-31).
        // Routing reads the practice as it now stands — the caseload moved, the
        // supervisees repointed, the account closed — so it needs no projection
        // of it: a transferred client's alert reaches the receiver, a
        // discharged one's the leaver's supervisor, a departed supervisee's
        // client's their new supervisor, and each of those a cover while that
        // person is away (leave D-26).
        const unread = await tx.alert.findMany({
          where: { recipientId: d.userId, acknowledgedAt: null },
          select: { id: true, clientId: true, client: { select: ROUTED_CLIENT } },
        });
        if (unread.length) {
          const routes = await routesOf(tx, unread.map((a) => a.client), localDateOf(now));
          for (const a of unread) {
            const to = routes.get(a.clientId)!;
            // The blocker scan refuses a departure that would strand one, so
            // this is the belt: leave it unread where it is rather than write
            // it to a closed account.
            if (strands(d.userId, a.client, to.recipientId)) continue;
            await tx.alert.update({ where: { id: a.id }, data: to });
            await note(tx, 'departure:alert_repointed', a.clientId);
          }
        }

        return tx.departure.update({ where: { id: d.id }, data: { status: 'executed', executedAt: now } });
      },
      tx as Tx,
    ), { timeout: 30_000 });
  } catch (e) {
    if (conflictKind(e) === 'clinician') {
      throw new Conflict("A moved session clashes with the receiving clinician's calendar", 'hour_clash');
    }
    throw e;
  }
}
