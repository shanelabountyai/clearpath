import { guarded } from '../auth/guard';
import { requiresCoSignature, type Actor } from '../auth/permissions';
import { systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { clientTarget } from '../clients/repository';
import { Conflict, NotFound } from '../errors';

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

async function progressContext(noteId: string) {
  const note = await prisma.progressNote.findUnique({
    where: { id: noteId },
    select: {
      id: true, clientId: true, authorId: true, status: true, content: true,
      author: { select: { role: true, supervisorId: true } },
    },
  });
  if (!note) throw new NotFound('ProgressNote');
  return {
    note,
    target: {
      authorId: note.authorId,
      authorSupervisorId: note.author.supervisorId ?? undefined,
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
      target: { clinicianId: appt.clinicianId },
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
  const { note, target } = await progressContext(noteId);
  if (note.status === 'draft') throw new Conflict('The author has not signed this note yet', 'not_signed');
  if (note.status === 'cosigned') throw new Conflict('This note is already co-signed', 'already_cosigned');

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

  return guarded(
    { actor, action: 'update', resource: 'progress_note', resourceId: noteId, clientId: note.clientId, target },
    (tx) =>
      tx.noteAmendment.create({
        data: { kind: 'progress', progressNoteId: noteId, authorId: actor.id, content },
      }),
  );
}

/** Progress notes on a client's record — the author's own and, for a supervisor, their supervisees'. */
export async function listProgressNotes(actor: Actor, clientId: string) {
  const supervisees = await prisma.user.findMany({
    where: { supervisorId: actor.id },
    select: { id: true },
  });
  const readable = [actor.id, ...supervisees.map((s) => s.id)];

  return guarded(
    {
      actor, action: 'read', resource: 'progress_note', clientId,
      target: { authorId: actor.id },
    },
    (tx) =>
      tx.progressNote.findMany({
        where: { clientId, authorId: { in: readable } },
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
  const supervisees = await prisma.user.findMany({
    where: { supervisorId: actor.id },
    select: { id: true },
  });
  if (supervisees.length === 0) return [];

  return guarded(
    {
      actor, action: 'read', resource: 'progress_note',
      target: { authorId: actor.id, authorSupervisorId: actor.id },
    },
    async (tx) => {
      const notes = await tx.progressNote.findMany({
        where: { status: 'signed', authorId: { in: supervisees.map((s) => s.id) } },
        select: {
          id: true, signedAt: true, clientId: true,
          author: { select: { id: true, name: true } },
          client: { select: { code: true, firstName: true, lastName: true } },
          appointment: { select: { startAt: true } },
        },
        orderBy: { signedAt: 'asc' },
      });
      return notes.map((n) => ({
        ...n,
        waitingDays: n.signedAt
          ? Math.floor((now.getTime() - n.signedAt.getTime()) / 86_400_000)
          : 0,
      }));
    },
  );
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
