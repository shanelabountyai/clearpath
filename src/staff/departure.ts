import { auditEvent } from '../auth/guard';
import { DAY, systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { Conflict } from '../errors';
import { SYSTEM_ACTOR } from '../scheduling/reminders';

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
