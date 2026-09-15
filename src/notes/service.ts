import { guarded, guardedAll, may } from '../auth/guard';
import { can, requiresCoSignature, type Actor, type Target } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { clientTarget } from '../clients/repository';
import { Conflict, NotFound } from '../errors';
import { coverageOf, supervisionCoverageOf, supervisionCoveredBy } from '../staff/coverage';
import { localDateOf, type LocalDate } from '../time';

/**
 * Two classes of clinical note, with deliberately different rules.
 *
 * A **progress note** is the official record: the author writes it, an
 * associate's goes to their supervisor for countersignature, and break-glass
 * can reach it. Once signed it is frozen and corrections append.
 *
 * A **process note** is the therapist's own working thinking: what they noticed,
 * what they might try, a hypothesis they would not want misread. It has one
 * reader, forever. Not the supervisor who countersigns the same session's
 * progress note. Not the practice manager with a reason. Not an export, a
 * search, or a report.
 *
 * Every process-note query below filters on `authorId` in SQL as well as
 * passing the permission check, because the check protects the endpoint and the
 * filter protects everything that ever calls the repository — including code
 * written later by someone who has not read this comment.
 */

// ───────────────────────────── progress notes ─────────────────────────────

/**
 * The three claimants `authorSupervisorOrTreating` names, resolved from the
 * note and from the client it belongs to.
 *
 * The client's `treatingClinicianId` is selected here rather than at each of
 * the five call sites, because it is the fact that makes D-04's rule
 * satisfiable at all: a target carrying only the author and their supervisor
 * decides `false` for the clinician who carries the client now, whatever the
 * matrix says. One join on a query that already runs, and read, update, sign,
 * cosign and amend all inherit it.
 *
 * Note that this hands `update`, `sign` and `cosign` a wider target than they
 * can use — those cells are `author` and `supervisorOfAuthor`, and the extra
 * field decides nothing. That is the right direction for the resolution to be
 * wrong in: the matrix narrows, the caller does not.
 */
async function progressContext(noteId: string, clock: Clock = systemClock) {
  const note = await prisma.progressNote.findUnique({
    where: { id: noteId },
    select: {
      id: true, clientId: true, authorId: true, status: true, content: true,
      author: { select: { role: true, supervisorId: true } },
      client: { select: { treatingClinicianId: true } },
    },
  });
  if (!note) throw new NotFound('ProgressNote');
  const today = localDateOf(clock.now());
  const treating = { id: note.clientId, treatingClinicianId: note.client.treatingClinicianId };
  const supervisorId = note.author.supervisorId;
  const [coverage, supervision] = await Promise.all([
    coverageOf(prisma, [treating], today),
    supervisionCoverageOf(prisma, [supervisorId], today),
  ]);
  return {
    note,
    target: {
      authorId: note.authorId,
      authorSupervisorId: supervisorId ?? undefined,
      clinicianId: note.client.treatingClinicianId,
      coverage: coverage.get(note.clientId),
      // Whoever covers the author's supervisor, who countersigns in their place (leave D-21).
      authorSupervisorCoverage: supervisorId ? supervision.get(supervisorId) : undefined,
      today,
    },
  };
}

export async function createProgressNote(
  actor: Actor,
  input: { appointmentId: string; content: string },
) {
  const appt = await prisma.appointment.findUnique({
    where: { id: input.appointmentId },
    select: { clientId: true, clinicianId: true },
  });
  if (!appt) throw new NotFound('Appointment');

  return guarded(
    {
      actor, action: 'create', resource: 'progress_note', clientId: appt.clientId,
      // The session's clinician writes it down; so does the client's coverer, holding it (D-16).
      target: { ...(await clientTarget(appt.clientId)), clinicianId: appt.clinicianId },
    },
    (tx) =>
      tx.progressNote.create({
        data: {
          appointmentId: input.appointmentId,
          clientId: appt.clientId,
          authorId: actor.id,
          content: input.content,
        },
      }),
  );
}

export async function updateProgressNote(actor: Actor, noteId: string, content: string) {
  const { note, target } = await progressContext(noteId);
  if (note.status !== 'draft') {
    throw new Conflict('A signed note cannot be edited. Add an amendment instead.', 'note_signed');
  }
  return guarded(
    { actor, action: 'update', resource: 'progress_note', resourceId: noteId, clientId: note.clientId, target },
    (tx) => tx.progressNote.update({ where: { id: noteId }, data: { content } }),
  );
}

interface SignResult {
  id: string;
  status: 'signed' | 'cosigned';
  /** True while an associate's note still awaits its supervisor. */
  pendingCoSignature: boolean;
  supervisorId: string | null;
}

/**
 * Sign. For a licensed clinician that completes the record; for an associate it
 * starts the clock on their supervisor's queue.
 */
export async function signProgressNote(
  actor: Actor,
  noteId: string,
  opts: { clock?: Clock } = {},
): Promise<SignResult> {
  const { note, target } = await progressContext(noteId);
  if (note.status !== 'draft') throw new Conflict('This note is already signed', 'already_signed');

  const needsCoSign = requiresCoSignature(note.author.role);
  if (needsCoSign && !note.author.supervisorId) {
    throw new Conflict(
      'This author has no supervisor assigned, so the note cannot be completed',
      'no_supervisor',
    );
  }

  const signed = await guarded(
    { actor, action: 'sign', resource: 'progress_note', resourceId: noteId, clientId: note.clientId, target },
    (tx) =>
      tx.progressNote.update({
        where: { id: noteId },
        data: { status: 'signed', signedAt: (opts.clock ?? systemClock).now() },
      }),
  );

  return {
    id: signed.id,
    status: 'signed',
    pendingCoSignature: needsCoSign,
    supervisorId: note.author.supervisorId,
  };
}

export async function coSignProgressNote(actor: Actor, noteId: string, opts: { clock?: Clock } = {}) {
  // The clock decides the target too: a supervision cover countersigns only inside the window (leave D-21).
  const { note, target } = await progressContext(noteId, opts.clock);
  if (note.status === 'draft') throw new Conflict('The author has not signed this note yet', 'not_signed');
  if (note.status === 'cosigned') throw new Conflict('This note is already co-signed', 'already_cosigned');
  // P0-4b. A co-signature countersigns somebody's signature, and an abandoned
  // note has none — the author left before making one. Co-signing here would
  // put a second name on a record nobody ever attested to, which is the exact
  // false attestation `sign: 'author'` refuses to allow in the first place.
  if (note.status === 'abandoned') {
    throw new Conflict('This note was never signed and never will be', 'note_abandoned');
  }

  const now = (opts.clock ?? systemClock).now();
  return guarded(
    { actor, action: 'cosign', resource: 'progress_note', resourceId: noteId, clientId: note.clientId, target },
    (tx) =>
      tx.progressNote.update({
        where: { id: noteId },
        data: { status: 'cosigned', coSignedById: actor.id, coSignedAt: now },
      }),
  );
}

/**
 * Whether to draw the co-sign button, decided on the target the co-signature
 * itself is, so the cover for an away supervisor sees it too. Silent, like `may`.
 */
export async function mayCoSign(actor: Actor, noteId: string) {
  const { target } = await progressContext(noteId);
  return may({ actor, action: 'cosign', resource: 'progress_note', target });
}

/**
 * The supervisors whose supervision this person covers today, and their
 * supervisees — each leave admitted by the co-sign cell it exists for (leave D-21).
 */
async function coveredSupervision(actor: Actor, today: LocalDate) {
  return (await supervisionCoveredBy(prisma, actor.id, today)).filter((r) => can(actor, 'cosign', 'progress_note', {
    authorSupervisorId: r.supervisorId, authorSupervisorCoverage: r.coverage, today,
  }).allowed);
}

export async function getProgressNote(actor: Actor, noteId: string) {
  const { note, target } = await progressContext(noteId);
  return guarded(
    { actor, action: 'read', resource: 'progress_note', resourceId: noteId, clientId: note.clientId, target },
    (tx) =>
      tx.progressNote.findUniqueOrThrow({
        where: { id: noteId },
        include: {
          author: { select: { id: true, name: true, role: true, supervisorId: true } },
          coSignedBy: { select: { id: true, name: true } },
          appointment: { select: { id: true, startAt: true } },
          amendments: { orderBy: { createdAt: 'asc' }, include: { author: { select: { name: true } } } },
        },
      }),
  );
}

/**
 * A signed note is immutable, so a correction appends. The original stays
 * exactly as it was signed — that is the point of signing it.
 */
export async function amendProgressNote(actor: Actor, noteId: string, content: string) {
  const { note, target } = await progressContext(noteId);
  if (note.status === 'draft') throw new Conflict('Edit the draft instead of amending it', 'still_draft');
  // Amendment is how a *signed* record is corrected without rewriting it. An
  // abandoned note is not a record — it is the hole where one should have been
  // — and appending to it would grow content on a note nobody signed.
  if (note.status === 'abandoned') {
    throw new Conflict('An abandoned note cannot be amended', 'note_abandoned');
  }

  return guarded(
    { actor, action: 'update', resource: 'progress_note', resourceId: noteId, clientId: note.clientId, target },
    (tx) =>
      tx.noteAmendment.create({
        data: { kind: 'progress', progressNoteId: noteId, authorId: actor.id, content },
      }),
  );
}

/**
 * Progress notes on a client's record, scoped to the three claimants D-04
 * names: the author, the supervisor of an author, and the clinician who
 * carries this client now.
 *
 * The scope is in the SQL, not in the guard. One `guarded` call cannot decide
 * a list — the matrix answers about one note and this returns many — so the
 * check here is the door and the `where` is the policy, which is why the two
 * have to say the same thing. The treating clinician reads the whole record
 * because that is exactly what D-04 granted; everybody else still sees only
 * what they or a supervisee wrote.
 */
export async function listProgressNotes(actor: Actor, clientId: string, clock: Clock = systemClock) {
  const today = localDateOf(clock.now());
  const [target, supervisees, standingIn] = await Promise.all([
    clientTarget(clientId, clock),
    prisma.user.findMany({ where: { supervisorId: actor.id }, select: { id: true } }),
    coveredSupervision(actor, today),
  ]);
  const { clinicianId } = target;
  // The cover for an away supervisor reads what that supervisor's supervisees wrote (leave D-21).
  const readable = [actor.id, ...supervisees.map((s) => s.id), ...standingIn.flatMap((r) => r.superviseeIds)];
  const treating = clinicianId === actor.id;
  // The coverer reads the record the treating clinician reads, for the window
  // (leave D-04). Asked of the matrix, and only a read a leave alone decided
  // counts: break-glass passes the same cell and must not widen the list.
  const covering = !treating && !!can(actor, 'read', 'progress_note', target).coveringLeaveId;

  // One door per authority the list actually spends, the way `coSignQueue`
  // does it, so a cover standing in on two leaves cannot have both reads
  // attributed to whichever leave sorted first. `guardedAll` nests them: N
  // audit rows, each carrying its own `leave:<id>`, one query, one transaction.
  // Without `authorId` for the coverer, so that row names the leave.
  //
  // A leave whose supervisees wrote nothing here still gets a row, because the
  // query spanned them either way — the same over-report `coSignQueue` makes on
  // an empty queue, and the direction to be wrong in.
  const doors: Target[] = covering
    ? [target]
    : [
        { authorId: actor.id, clinicianId },
        ...standingIn.map((r) => ({
          authorSupervisorId: r.supervisorId, authorSupervisorCoverage: r.coverage, today,
        })),
      ];

  return guardedAll(
    doors.map((t) => ({ actor, action: 'read' as const, resource: 'progress_note' as const, clientId, target: t })),
    (tx) =>
      tx.progressNote.findMany({
        where: { clientId, ...(treating || covering ? {} : { authorId: { in: readable } }) },
        select: {
          id: true, status: true, signedAt: true, coSignedAt: true, createdAt: true,
          author: { select: { id: true, name: true, role: true } },
          appointment: { select: { id: true, startAt: true } },
          _count: { select: { amendments: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
  );
}

/**
 * A supervisor's outstanding countersignatures, oldest first. Unsigned
 * supervisee notes are a compliance clock, so age is the sort key and the
 * number that matters.
 */
export async function coSignQueue(actor: Actor, opts: { clock?: Clock } = {}) {
  const now = (opts.clock ?? systemClock).now();
  const today = localDateOf(now);
  const [supervisees, standingIn] = await Promise.all([
    prisma.user.findMany({ where: { supervisorId: actor.id }, select: { id: true } }),
    coveredSupervision(actor, today),
  ]);

  // One guarded read per door: their own supervisees, and each leave they
  // cover, so every covered read carries its own `leave:<id>` (leave P0-9).
  const doors: { target: Target; authors: string[] }[] = [
    ...(supervisees.length ? [{ target: { authorId: actor.id, authorSupervisorId: actor.id }, authors: supervisees.map((s) => s.id) }] : []),
    ...standingIn.map((r) => ({
      target: { authorSupervisorId: r.supervisorId, authorSupervisorCoverage: r.coverage, today },
      authors: r.superviseeIds,
    })),
  ];
  const lists = await Promise.all(doors.map(({ target, authors }) => guarded(
    { actor, action: 'read', resource: 'progress_note', target },
    (tx) => tx.progressNote.findMany({
      where: { status: 'signed', authorId: { in: authors } },
      select: {
        id: true, signedAt: true, clientId: true,
        author: { select: { id: true, name: true } },
        client: { select: { code: true, firstName: true, lastName: true } },
        appointment: { select: { startAt: true } },
      },
    }),
  )));
  return lists.flat()
    .sort((a, b) => (a.signedAt?.getTime() ?? 0) - (b.signedAt?.getTime() ?? 0))
    .map((n) => ({
      ...n,
      waitingDays: n.signedAt
        ? Math.floor((now.getTime() - n.signedAt.getTime()) / 86_400_000)
        : 0,
    }));
}

// ────────────────────────────── process notes ──────────────────────────────

export async function createProcessNote(
  actor: Actor,
  input: { clientId: string; appointmentId?: string | null; content: string },
) {
  return guarded(
    {
      actor, action: 'create', resource: 'process_note', clientId: input.clientId,
      target: await clientTarget(input.clientId),
    },
    (tx) =>
      tx.processNote.create({
        data: {
          clientId: input.clientId,
          appointmentId: input.appointmentId ?? null,
          authorId: actor.id,
          content: input.content,
        },
      }),
  );
}

/**
 * Read one. The `authorId` in the WHERE clause is not redundant with the
 * permission check: it means that even a caller that somehow reached this
 * function with the wrong actor gets a not-found rather than someone else's
 * private thinking.
 */
export async function getProcessNote(actor: Actor, noteId: string) {
  const note = await prisma.processNote.findUnique({
    where: { id: noteId },
    select: { id: true, authorId: true, clientId: true, closedAt: true },
  });
  if (!note) throw new NotFound('ProcessNote');

  return guarded(
    {
      actor, action: 'read', resource: 'process_note', resourceId: noteId, clientId: note.clientId,
      target: { authorId: note.authorId },
    },
    async (tx) => {
      const row = await tx.processNote.findFirst({
        where: { id: noteId, authorId: actor.id },
        include: { amendments: { orderBy: { createdAt: 'asc' } } },
      });
      if (!row) throw new NotFound('ProcessNote');
      return row;
    },
  );
}

/** A client's process notes — always and only the calling author's own. */
export async function listProcessNotes(actor: Actor, clientId: string) {
  return guarded(
    {
      actor, action: 'read', resource: 'process_note', clientId,
      target: { authorId: actor.id },
    },
    (tx) =>
      tx.processNote.findMany({
        where: { clientId, authorId: actor.id },
        select: { id: true, createdAt: true, updatedAt: true, closedAt: true, appointmentId: true },
        orderBy: { createdAt: 'desc' },
      }),
  );
}

export async function updateProcessNote(actor: Actor, noteId: string, content: string) {
  const note = await prisma.processNote.findUnique({
    where: { id: noteId }, select: { authorId: true, clientId: true, closedAt: true },
  });
  if (!note) throw new NotFound('ProcessNote');
  if (note.closedAt) throw new Conflict('This note is closed. Add an amendment instead.', 'note_closed');

  return guarded(
    {
      actor, action: 'update', resource: 'process_note', resourceId: noteId, clientId: note.clientId,
      target: { authorId: note.authorId },
    },
    async (tx) => {
      const { count } = await tx.processNote.updateMany({
        where: { id: noteId, authorId: actor.id },
        data: { content },
      });
      if (count === 0) throw new NotFound('ProcessNote');
      return tx.processNote.findFirstOrThrow({ where: { id: noteId, authorId: actor.id } });
    },
  );
}

export async function closeProcessNote(actor: Actor, noteId: string, opts: { clock?: Clock } = {}) {
  const note = await prisma.processNote.findUnique({
    where: { id: noteId }, select: { authorId: true, clientId: true },
  });
  if (!note) throw new NotFound('ProcessNote');

  return guarded(
    {
      actor, action: 'update', resource: 'process_note', resourceId: noteId, clientId: note.clientId,
      target: { authorId: note.authorId },
    },
    async (tx) => {
      const { count } = await tx.processNote.updateMany({
        where: { id: noteId, authorId: actor.id },
        data: { closedAt: (opts.clock ?? systemClock).now() },
      });
      if (count === 0) throw new NotFound('ProcessNote');
      return tx.processNote.findFirstOrThrow({ where: { id: noteId, authorId: actor.id } });
    },
  );
}

export async function amendProcessNote(actor: Actor, noteId: string, content: string) {
  const note = await prisma.processNote.findUnique({
    where: { id: noteId }, select: { authorId: true, clientId: true, closedAt: true },
  });
  if (!note) throw new NotFound('ProcessNote');
  if (!note.closedAt) throw new Conflict('Edit the note instead of amending it', 'still_open');

  return guarded(
    {
      actor, action: 'update', resource: 'process_note', resourceId: noteId, clientId: note.clientId,
      target: { authorId: note.authorId },
    },
    async (tx) => {
      if (note.authorId !== actor.id) throw new NotFound('ProcessNote');
      return tx.noteAmendment.create({
        data: { kind: 'process', processNoteId: noteId, authorId: actor.id, content },
      });
    },
  );
}
