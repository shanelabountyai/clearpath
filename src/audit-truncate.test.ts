import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db';
import { makeUser, resetDb } from './test/harness';

// Review #1: the append-only triggers were FOR EACH ROW on UPDATE/DELETE, and
// TRUNCATE fires neither, so one statement could empty the audit log.
describe('audit log and amendments refuse TRUNCATE', () => {
  beforeEach(resetDb);

  it('refuses TRUNCATE on AuditEvent', async () => {
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent"')).rejects.toThrow(/append-only/);
  });

  it('refuses TRUNCATE on NoteAmendment, including by CASCADE from a table it references', async () => {
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "NoteAmendment"')).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE')).rejects.toThrow(/append-only/);
  });

  it('resetDb still empties them and leaves the triggers enabled afterwards', async () => {
    const u = await makeUser('therapist');
    await prisma.auditEvent.create({
      data: { actorId: u.id, actorRole: 'therapist', action: 'read', resource: 'client', allowed: true, rule: 'test' },
    });
    await resetDb();
    expect(await prisma.auditEvent.count()).toBe(0);
    const off = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgname LIKE '%_no_%' AND NOT tgisinternal AND tgenabled = 'D'
    `;
    expect(off).toEqual([]);
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent"')).rejects.toThrow(/append-only/);
  });
});

describe('resetDb refuses a non-local database', () => {
  const saved = { url: process.env.DATABASE_URL, allow: process.env.CLEARPATH_ALLOW_CLOUD_DB };
  afterEach(() => {
    process.env.DATABASE_URL = saved.url;
    if (saved.allow === undefined) delete process.env.CLEARPATH_ALLOW_CLOUD_DB;
    else process.env.CLEARPATH_ALLOW_CLOUD_DB = saved.allow;
  });

  it('throws before touching anything when DATABASE_URL is remote and the cloud flag is unset', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@ep-example.neon.tech/db';
    delete process.env.CLEARPATH_ALLOW_CLOUD_DB;
    await expect(resetDb()).rejects.toThrow(/non-local/);
  });
});
