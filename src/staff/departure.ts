import { randomUUID } from 'node:crypto';
import { auditEvent, guarded, may } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { DAY, systemClock, type Clock } from '../clock';
import { prisma, type Tx } from '../db';
import { Conflict, NotFound } from '../errors';
import { conflictKind } from '../scheduling/booking';
import { TRANSITIONS as SESSION_TRANSITIONS, type Status as SessionStatus } from '../scheduling/lifecycle';
import { SYSTEM_ACTOR } from '../scheduling/reminders';
import { zonedToUtc, type LocalDate } from '../time';

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
  const settings = await prisma.practiceSettings.findUnique({ where: { id: 1 } });
  const cutoff = new Date(
    clock.now().getTime() - (settings?.processNoteAfterDepartureDays ?? 2555) * DAY,
  );

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

  // Decided here for the reason `convertInquiry` decides its client id: the
  // audit row names the departure, and a row that does not exist yet cannot be
  // named.
  const id = randomUUID();
  return guarded(
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
  | { kind: 'supervisee_unassigned'; superviseeId: string };

/** Sessions that have not happened yet. Derived, so a new status cannot be forgotten here. */
const OPEN_SESSIONS = (Object.keys(SESSION_TRANSITIONS) as SessionStatus[])
  .filter((s) => SESSION_TRANSITIONS[s].length > 0);

/** Practice-local midnight at the start of the last day. */
const lastDayStart = (lastDayOn: Date) => zonedToUtc(lastDayOn.toISOString().slice(0, 10), 0);

type DepartureRow = {
  id: string; userId: string; lastDayOn: Date; receivingSupervisorId: string | null;
};

async function blockersOf(db: Tx | typeof prisma, d: DepartureRow): Promise<DepartureBlocker[]> {
  const from = lastDayStart(d.lastDayOn);
  const [leaver, caseload, assignments, alerts, supervisees, receivingSupervisor] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: d.userId }, select: { supervisorId: true } }),
    db.client.findMany({ where: { treatingClinicianId: d.userId, status: 'active' }, select: { id: true } }),
    db.departureAssignment.findMany({
      where: { departureId: d.id },
      select: {
        clientId: true, disposition: true, receivingClinicianId: true,
        receivingClinician: { select: { active: true } },
      },
    }),
    db.alert.findMany({
      where: { recipientId: d.userId, acknowledgedAt: null },
      select: { id: true, clientId: true },
    }),
    db.user.findMany({ where: { supervisorId: d.userId }, select: { id: true } }),
    d.receivingSupervisorId
      ? db.user.findUnique({ where: { id: d.receivingSupervisorId }, select: { id: true, role: true, active: true } })
      : null,
  ]);

  const decided = new Map(assignments.map((a) => [a.clientId, a]));
  const blockers: DepartureBlocker[] = [];

  for (const c of caseload) {
    if (!decided.has(c.id)) blockers.push({ kind: 'undecided', clientId: c.id });
  }
  for (const a of assignments) {
    if (a.receivingClinicianId && (a.receivingClinicianId === d.userId || !a.receivingClinician?.active)) {
      blockers.push({ kind: 'receiver_unavailable', clientId: a.clientId, receivingClinicianId: a.receivingClinicianId });
    }
  }
  // P0-7: an unread risk alert is not something a departure gets to close over.
  if (!leaver.supervisorId) {
    for (const alert of alerts) {
      if (decided.get(alert.clientId)?.disposition !== 'transfer') {
        blockers.push({ kind: 'unread_alert', clientId: alert.clientId, alertId: alert.id });
      }
    }
  }
  // P0-8: a receiver the matrix would never let co-sign for an associate leaves
  // every associate with a co-signature nobody can give. Asked of the matrix
  // rather than of a role name, per hard rule 1 — so it stays right if who may
  // co-sign ever changes.
  const receiverCanSupervise = !!receivingSupervisor?.active && may({
    actor: { id: receivingSupervisor.id, role: receivingSupervisor.role },
    action: 'cosign', resource: 'progress_note',
    target: { authorSupervisorId: receivingSupervisor.id },
  });
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

  return blockers;
}

const DEPARTURE_ROW = { id: true, userId: true, lastDayOn: true, receivingSupervisorId: true, status: true } as const;

/** The plan screen's answer to "is this departure ready?" Read-guarded, because it names clients. */
export async function departureBlockers(actor: Actor, departureId: string) {
  const d = await prisma.departure.findUnique({ where: { id: departureId }, select: DEPARTURE_ROW });
  if (!d) throw new NotFound('Departure');
  return guarded(
    { actor, action: 'read', resource: 'departure', resourceId: departureId, target: { subjectUserId: d.userId } },
    (tx) => blockersOf(tx, d),
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
 * neighbour.
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

  try {
    // ponytail: 30s budget for a whole caseload in one transaction; batch the
    // audit rows with createMany if a real caseload ever measures near it.
    return await prisma.$transaction((tx) => guarded(
      {
        actor, action: 'depart', resource: 'departure', resourceId: d.id,
        target: { subjectUserId: d.userId },
      },
      async (tx) => {
        const blockers = (await blockersOf(tx, d)).filter((b) => b.kind !== 'hour_clash');
        if (blockers.length) {
          throw new Conflict(`This departure has ${blockers.length} unresolved item(s)`, 'departure_not_ready');
        }

        const leaver = await tx.user.findUniqueOrThrow({ where: { id: d.userId }, select: { supervisorId: true } });
        const assignments = await tx.departureAssignment.findMany({
          where: { departureId: d.id },
          select: { clientId: true, disposition: true, receivingClinicianId: true },
        });

        for (const a of assignments) {
          const future = { clientId: a.clientId, clinicianId: d.userId, startAt: { gte: from }, status: { in: OPEN_SESSIONS } };
          const receiver = a.receivingClinicianId;

          if (receiver) {
            await tx.client.update({ where: { id: a.clientId }, data: { treatingClinicianId: receiver } });
            // The write the exclusion constraint may refuse — after the client
            // row on purpose, so a clash proves the rollback rather than
            // preceding every write.
            await tx.appointment.updateMany({ where: future, data: { clinicianId: receiver } });
            await tx.appointmentSeries.updateMany({
              where: { clientId: a.clientId, clinicianId: d.userId, active: true },
              data: { clinicianId: receiver },
            });
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

          // P0-7. Acknowledged alerts stay where they are: "Alex saw this on
          // the 12th" is a fact about the 12th. Unread ones follow the client
          // to its new clinician, or to the leaver's supervisor when the client
          // has none — which the blocker scan has already guaranteed exists.
          const alertTo = receiver ?? leaver.supervisorId;
          const unread = await tx.alert.findMany({
            where: { recipientId: d.userId, clientId: a.clientId, acknowledgedAt: null },
            select: { id: true },
          });
          if (alertTo && unread.length) {
            await tx.alert.updateMany({ where: { id: { in: unread.map((x) => x.id) } }, data: { recipientId: alertTo } });
            for (const _ of unread) await note(tx, 'departure:alert_repointed', a.clientId);
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
        for (const n of drafts) await note(tx, 'departure:note_abandoned', n.clientId);

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
        for (const n of unreachable) await note(tx, 'departure:process_note_unreachable', n.clientId);

        await tx.user.update({ where: { id: d.userId }, data: { active: false } });
        await note(tx, 'departure:deactivated');

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
