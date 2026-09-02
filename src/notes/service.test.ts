import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Conflict, Forbidden } from '../errors';
import { fixedClock, DAY } from '../clock';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from '../scheduling/booking';
import {
  amendProcessNote, amendProgressNote, closeProcessNote, coSignProgressNote, coSignQueue,
  createProcessNote, createProgressNote, getProcessNote, getProgressNote, listProcessNotes,
  listProgressNotes, signProgressNote, updateProcessNote, updateProgressNote,
} from './service';

let desk: Awaited<ReturnType<typeof makeUser>>;
let supervisor: Awaited<ReturnType<typeof makeUser>>;
let associate: Awaited<ReturnType<typeof makeUser>>;
let therapist: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let client: Awaited<ReturnType<typeof makeClient>>;
let appointmentId: string;

beforeEach(async () => {
  await resetDb();
  await settings();
  await makeRoom('Room 1');
  desk = await makeUser('front_desk');
  admin = await makeUser('admin');
  supervisor = await makeUser('supervisor');
  associate = await makeUser('associate', { supervisorId: supervisor.id });
  therapist = await makeUser('therapist');
  client = await makeClient(associate.id);
  await prisma.availability.create({ data: { userId: associate.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
  const appt = await bookAppointment(actor(desk), {
    clientId: client.id, clinicianId: associate.id, date: '2026-09-01',
    startMinute: 900, type: 'standard', modality: 'in_person',
  });
  appointmentId = appt.id;
});
afterAll(() => prisma.$disconnect());

const draft = () => createProgressNote(actor(associate), { appointmentId, content: 'Session focus: sleep.' });

describe('the co-signature workflow', () => {
  it("routes an associate's signed note to their supervisor", async () => {
    const note = await draft();
    const signed = await signProgressNote(actor(associate), note.id);
    expect(signed).toMatchObject({ status: 'signed', pendingCoSignature: true, supervisorId: supervisor.id });

    const queue = await coSignQueue(actor(supervisor));
    expect(queue.map((n) => n.id)).toEqual([note.id]);
  });

  it("completes a licensed clinician's note at signature", async () => {
    const own = await makeClient(therapist.id);
    await prisma.availability.create({ data: { userId: therapist.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
    const appt = await bookAppointment(actor(desk), {
      clientId: own.id, clinicianId: therapist.id, date: '2026-09-01',
      startMinute: 600, type: 'standard', modality: 'in_person',
    });
    const note = await createProgressNote(actor(therapist), { appointmentId: appt.id, content: 'x' });
    const signed = await signProgressNote(actor(therapist), note.id);
    expect(signed.pendingCoSignature).toBe(false);
    expect(await coSignQueue(actor(supervisor))).toEqual([]);
  });

  it('leaves the record incomplete until both signatures exist', async () => {
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    expect((await getProgressNote(actor(associate), note.id)).status).toBe('signed');

    await coSignProgressNote(actor(supervisor), note.id);
    const done = await getProgressNote(actor(supervisor), note.id);
    expect(done.status).toBe('cosigned');
    expect(done.coSignedBy?.id).toBe(supervisor.id);
    expect(await coSignQueue(actor(supervisor))).toEqual([]);
  });

  it('will not co-sign a note the author has not signed', async () => {
    const note = await draft();
    await expect(coSignProgressNote(actor(supervisor), note.id)).rejects.toMatchObject({ code: 'not_signed' });
  });

  it('will not let a different supervisor co-sign', async () => {
    const stranger = await makeUser('supervisor');
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    await expect(coSignProgressNote(actor(stranger), note.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it('will not let the associate co-sign their own note', async () => {
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    await expect(coSignProgressNote(actor(associate), note.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it('reroutes when the supervision relationship is reassigned', async () => {
    const newBoss = await makeUser('supervisor');
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    expect(await coSignQueue(actor(newBoss))).toEqual([]);

    await prisma.user.update({ where: { id: associate.id }, data: { supervisorId: newBoss.id } });

    expect(await coSignQueue(actor(supervisor))).toEqual([]);
    expect((await coSignQueue(actor(newBoss))).map((n) => n.id)).toEqual([note.id]);
    await expect(coSignProgressNote(actor(supervisor), note.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(coSignProgressNote(actor(newBoss), note.id)).resolves.toBeTruthy();
  });

  it('ages the queue, because an unsigned supervisee note is a clock', async () => {
    const note = await draft();
    const signedAt = new Date('2026-09-01T20:00:00Z');
    await signProgressNote(actor(associate), note.id, { clock: fixedClock(signedAt) });
    const queue = await coSignQueue(actor(supervisor), {
      clock: fixedClock(new Date(signedAt.getTime() + 9 * DAY)),
    });
    expect(queue[0]!.waitingDays).toBe(9);
  });

  it('refuses to sign when an associate has no supervisor assigned', async () => {
    await prisma.user.update({ where: { id: associate.id }, data: { supervisorId: null } });
    const note = await draft();
    await expect(signProgressNote(actor(associate), note.id)).rejects.toMatchObject({ code: 'no_supervisor' });
  });
});

describe('signed notes are immutable', () => {
  it('refuses an edit at the service layer', async () => {
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    await expect(updateProgressNote(actor(associate), note.id, 'rewritten')).rejects.toMatchObject({ code: 'note_signed' });
  });

  it('refuses an edit at the database layer, whatever the service does', async () => {
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    await expect(
      prisma.progressNote.update({ where: { id: note.id }, data: { content: 'rewritten' } }),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses to un-sign', async () => {
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    await expect(
      prisma.progressNote.update({ where: { id: note.id }, data: { status: 'draft' } }),
    ).rejects.toThrow(/cannot return to draft/);
  });

  it('turns the affordance into an amendment, which appends', async () => {
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    await amendProgressNote(actor(associate), note.id, 'Correction: the session ran 40 minutes.');

    const full = await getProgressNote(actor(associate), note.id);
    expect(full.content).toBe('Session focus: sleep.');
    expect(full.amendments).toHaveLength(1);
    expect(full.amendments[0]!.content).toContain('Correction');
  });

  it('will not amend a draft — edit it', async () => {
    const note = await draft();
    await expect(amendProgressNote(actor(associate), note.id, 'x')).rejects.toMatchObject({ code: 'still_draft' });
  });

  it('keeps amendments append-only at the database layer too', async () => {
    const note = await draft();
    await signProgressNote(actor(associate), note.id);
    const amendment = await amendProgressNote(actor(associate), note.id, 'first');
    await expect(
      prisma.noteAmendment.update({ where: { id: amendment.id }, data: { content: 'rewritten' } }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('a process note has one reader, forever', () => {
  const mine = () => createProcessNote(actor(associate), { clientId: client.id, appointmentId, content: 'Hypothesis: avoidance, not apathy.' });

  it('is readable by its author', async () => {
    const note = await mine();
    expect((await getProcessNote(actor(associate), note.id)).content).toContain('Hypothesis');
  });

  it('is denied to the supervisor who co-signs the same session', async () => {
    const progress = await draft();
    await signProgressNote(actor(associate), progress.id);
    await coSignProgressNote(actor(supervisor), progress.id);

    const note = await mine();
    await expect(getProcessNote(actor(supervisor), note.id)).rejects.toBeInstanceOf(Forbidden);

    const [denial] = await prisma.auditEvent.findMany({
      where: { resource: 'process_note', allowed: false }, orderBy: { at: 'desc' },
    });
    expect(denial).toMatchObject({ actorId: supervisor.id, clientId: client.id });
  });

  it('is denied to the practice manager, break glass or not', async () => {
    const note = await mine();
    await expect(getProcessNote(actor(admin), note.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(getProcessNote(actor(admin, 'court order'), note.id)).rejects.toMatchObject({ absolute: true });

    const flagged = await prisma.auditEvent.findMany({ where: { breakGlass: true } });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ allowed: false, resource: 'process_note' });
  });

  it('is denied to front desk and to an auditor', async () => {
    const note = await mine();
    const auditorUser = await makeUser('auditor');
    await expect(getProcessNote(actor(desk), note.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(getProcessNote(actor(auditorUser), note.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it('is denied to the treating clinician when someone else wrote it', async () => {
    // Coverage: a colleague saw this client once and kept their own notes.
    const note = await createProcessNote(actor(associate), { clientId: client.id, content: 'mine' });
    await prisma.client.update({ where: { id: client.id }, data: { treatingClinicianId: therapist.id } });
    await expect(getProcessNote(actor(therapist), note.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it('never appears in a list belonging to anyone else', async () => {
    await mine();
    expect(await listProcessNotes(actor(associate), client.id)).toHaveLength(1);
    expect(await listProcessNotes(actor(supervisor), client.id)).toHaveLength(0);
    expect(await listProcessNotes(actor(therapist), client.id)).toHaveLength(0);
  });

  it('never leaks through the progress-note list', async () => {
    await mine();
    const progress = await draft();
    await signProgressNote(actor(associate), progress.id);
    const asSupervisor = await listProgressNotes(actor(supervisor), client.id);
    expect(asSupervisor).toHaveLength(1);
    expect(JSON.stringify(asSupervisor)).not.toContain('Hypothesis');
  });

  it('never leaks through the co-sign queue', async () => {
    await mine();
    const progress = await draft();
    await signProgressNote(actor(associate), progress.id);
    const queue = await coSignQueue(actor(supervisor));
    expect(JSON.stringify(queue)).not.toContain('Hypothesis');
  });

  it('cannot be edited by anyone else even if the check were bypassed', async () => {
    const note = await mine();
    // The repository filters on authorId in SQL as well as checking permission.
    await expect(updateProcessNote(actor(supervisor), note.id, 'tampered')).rejects.toBeInstanceOf(Forbidden);
    expect((await getProcessNote(actor(associate), note.id)).content).toContain('Hypothesis');
  });

  it('freezes once closed, and amends instead', async () => {
    const note = await mine();
    await closeProcessNote(actor(associate), note.id);
    await expect(updateProcessNote(actor(associate), note.id, 'x')).rejects.toMatchObject({ code: 'note_closed' });
    await expect(
      prisma.processNote.update({ where: { id: note.id }, data: { content: 'x' } }),
    ).rejects.toThrow(/immutable/);

    await amendProcessNote(actor(associate), note.id, 'Later thought: try behavioural activation.');
    expect((await getProcessNote(actor(associate), note.id)).amendments).toHaveLength(1);
  });

  it('logs the author reading their own note', async () => {
    const note = await mine();
    await getProcessNote(actor(associate), note.id);
    const reads = await prisma.auditEvent.findMany({ where: { resource: 'process_note', action: 'read' } });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ actorId: associate.id, allowed: true, rule: 'author' });
  });

  it('has no signature workflow at all', async () => {
    const note = await mine();
    const rows = await prisma.progressNote.findMany({ where: { id: note.id } });
    expect(rows).toEqual([]);
  });
});

describe('progress note reads', () => {
  it("let a supervisor read their supervisee's", async () => {
    const note = await draft();
    await expect(getProgressNote(actor(supervisor), note.id)).resolves.toBeTruthy();
  });

  it('deny an unrelated clinician', async () => {
    const note = await draft();
    await expect(getProgressNote(actor(therapist), note.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it('deny front desk', async () => {
    const note = await draft();
    await expect(getProgressNote(actor(desk), note.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it('let the practice manager through only with break-glass, flagged', async () => {
    const note = await draft();
    await expect(getProgressNote(actor(admin), note.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(getProgressNote(actor(admin, 'subpoena, ref 2026-114'), note.id)).resolves.toBeTruthy();
    const [row] = await prisma.auditEvent.findMany({ where: { breakGlass: true, allowed: true } });
    expect(row!.reason).toContain('subpoena');
  });
});

/**
 * The rule with no exceptions, checked structurally.
 *
 * Everything above tests the helpers that exist. This tests the one nobody has
 * written yet: a `processNote` query added later that filters by client and
 * forgets the author reads someone's private thinking, and every behavioural
 * test in this file still passes, because none of them call it. So the check is
 * on the shape of the call — `authorId` must appear inside the query itself,
 * which is the difference between filtering in SQL and filtering in JS.
 */
function sourceFiles() {
  const out: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      out.push(path);
    }
  }
  return out;
}

/** The argument text of the call starting at `from`, parens balanced. */
function callArgs(src: string, from: number): string {
  const open = src.indexOf('(', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function unauthoredProcessNoteQueries(): string[] {
  const offenders: string[] = [];
  for (const path of sourceFiles()) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/\bprocessNote\.\w+/g)) {
      const args = callArgs(src, (m.index ?? 0) + m[0].length);
      if (!args.includes('authorId')) offenders.push(`${path}: ${m[0]}`);
    }
  }
  return offenders;
}

it('every process-note query names the author inside the query', () => {
  expect(unauthoredProcessNoteQueries()).toEqual([]);
});
