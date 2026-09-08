import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, fixedClock } from '../clock';
import { prisma } from '../db';
import { Conflict, Forbidden } from '../errors';
import { actor, makeUser, resetDb, settings } from '../test/harness';
import { callArgs, readSource, sourceFiles } from '../test/source';
import {
  assertTransition, canTransition, createInquiry, discardInquiry, listInquiries,
  runInquiryPurge, TRANSITIONS, updateInquiry, type InquiryStatus,
} from './inquiry';

const STATUSES: InquiryStatus[] = ['open', 'converted', 'discarded'];

describe('the inquiry state machine (pure)', () => {
  it('opens, and then goes one of two ways', () => {
    expect(canTransition('open', 'converted')).toBe(true);
    expect(canTransition('open', 'discarded')).toBe(true);
  });

  it('treats both endings as terminal', () => {
    expect(TRANSITIONS.converted).toEqual([]);
    expect(TRANSITIONS.discarded).toEqual([]);
  });

  it('never returns to open, and never crosses between the endings', () => {
    for (const from of ['converted', 'discarded'] as InquiryStatus[]) {
      for (const to of STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('refuses to stay where it is', () => {
    for (const s of STATUSES) expect(canTransition(s, s), s).toBe(false);
  });

  it('raises Conflict on every illegal transition, and only those', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (canTransition(from, to)) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(Conflict);
        }
      }
    }
  });

  it('names no person in the refusal — the message reaches an API response', () => {
    try {
      assertTransition('discarded', 'converted');
    } catch (e) {
      expect((e as Conflict).message).toBe('A discarded inquiry cannot become converted');
      expect((e as Conflict).code).toBe('bad_transition');
    }
  });
});

/**
 * ──────────────────── the record, and what the database refuses ────────────────────
 */

let desk: Awaited<ReturnType<typeof makeUser>>;
let therapist: Awaited<ReturnType<typeof makeUser>>;

const T0 = '2026-09-01T10:00:00.000Z';

const anInquiry = (over: Partial<Parameters<typeof createInquiry>[1]> = {}) =>
  createInquiry(actor(desk), {
    firstName: 'A', lastName: 'Caller', phone: '(555) 010-0100',
    referralSource: 'gp', note: 'Tuesday evenings only', ...over,
  });

/** Only the purge can legally do this, so the tests reach for the raw delegate. */
const rawDelete = (id: string) => prisma.inquiry.delete({ where: { id } });

describe('the inquiry record', () => {
  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
  });
  afterAll(() => prisma.$disconnect());

  it('records a caller without inventing a date of birth', async () => {
    const inq = await anInquiry();
    expect(inq).toMatchObject({ status: 'open', discardedAt: null, discardReason: null, takenById: desk.id });
    expect(inq).not.toHaveProperty('dateOfBirth');
    expect(inq).not.toHaveProperty('code');
  });

  it('discards with a reason code and starts the retention clock', async () => {
    const inq = await anInquiry();
    const clock = fixedClock(T0);
    const discarded = await discardInquiry(actor(desk), inq.id, 'no_answer', { clock });

    expect(discarded).toMatchObject({ status: 'discarded', discardReason: 'no_answer' });
    expect(discarded.discardedAt).toEqual(new Date(T0));
  });

  it('refuses a second ending, through the state machine', async () => {
    const inq = await anInquiry();
    await discardInquiry(actor(desk), inq.id, 'spam');
    await expect(discardInquiry(actor(desk), inq.id, 'duplicate')).rejects.toThrow(Conflict);
  });

  it('lets a clinician write a call down, and not declare one dead', async () => {
    const own = await createInquiry(actor(therapist), {
      firstName: 'B', lastName: 'Caller', referralSource: 'friend',
    });
    await expect(discardInquiry(actor(therapist), own.id, 'not_a_fit')).rejects.toThrow(Forbidden);
    // The refusal is on the record, and the row is untouched.
    const denial = await prisma.auditEvent.findFirstOrThrow({
      where: { resource: 'inquiry', action: 'discard', allowed: false },
    });
    expect(denial.actorId).toBe(therapist.id);
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: own.id } })).status).toBe('open');
  });
});

/**
 * P0-5, asserted against a real connection. A mock of `inquiry.delete` proves
 * that the application does not delete an open inquiry, which was never the
 * question — the question is what happens when something else does.
 */
describe('the database refuses to delete anything but a discarded inquiry', () => {
  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
  });

  it('refuses an open one', async () => {
    const inq = await anInquiry();
    await expect(rawDelete(inq.id)).rejects.toThrow(/only be deleted once discarded/);
    expect(await prisma.inquiry.count()).toBe(1);
  });

  it('refuses a converted one — it is part of a client history now', async () => {
    const inq = await anInquiry();
    await prisma.inquiry.update({ where: { id: inq.id }, data: { status: 'converted' } });
    await expect(rawDelete(inq.id)).rejects.toThrow(/only be deleted once discarded/);
    expect(await prisma.inquiry.count()).toBe(1);
  });

  it('permits a discarded one', async () => {
    const inq = await anInquiry();
    await discardInquiry(actor(desk), inq.id, 'no_capacity');
    await rawDelete(inq.id);
    expect(await prisma.inquiry.count()).toBe(0);
  });

  it('refuses a discard with nothing for the sweep to count from', async () => {
    const inq = await anInquiry();
    await expect(
      prisma.inquiry.update({ where: { id: inq.id }, data: { status: 'discarded' } }),
    ).rejects.toThrow(/inquiry_discard_is_complete/);
  });
});

describe('the purge', () => {
  const WINDOW = 90;
  const past = new Date(new Date(T0).getTime() + (WINDOW + 1) * DAY);

  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
  });

  /** One of each ending, discarded at T0 where it is discarded at all. */
  async function seedQuarter() {
    const clock = fixedClock(T0);
    const open = await anInquiry({ firstName: 'Still' });
    const converted = await anInquiry({ firstName: 'Booked' });
    await prisma.inquiry.update({ where: { id: converted.id }, data: { status: 'converted' } });
    const dead = await anInquiry({ firstName: 'Gone' });
    await discardInquiry(actor(desk), dead.id, 'no_answer', { clock });
    const recent = await anInquiry({ firstName: 'Recent' });
    await discardInquiry(actor(desk), recent.id, 'chose_elsewhere', {
      clock: fixedClock(new Date(past.getTime() - DAY)),
    });
    return { open, converted, dead, recent };
  }

  it('destroys exactly the discarded rows past the window', async () => {
    const { open, converted, dead, recent } = await seedQuarter();

    expect(await runInquiryPurge(fixedClock(past))).toEqual([dead.id]);

    const left = await prisma.inquiry.findMany({ select: { id: true } });
    expect(left.map((r) => r.id).sort()).toEqual([open.id, converted.id, recent.id].sort());
  });

  it('is idempotent across repeated runs', async () => {
    const { dead } = await seedQuarter();
    expect(await runInquiryPurge(fixedClock(past))).toEqual([dead.id]);
    expect(await runInquiryPurge(fixedClock(past))).toEqual([]);
    expect(await runInquiryPurge(fixedClock(past))).toEqual([]);
    expect(await prisma.inquiry.count()).toBe(3);
  });

  it('reads its window from settings, not from a constant', async () => {
    const { dead, recent } = await seedQuarter();
    await settings({ inquiryRetentionDays: 1 });
    expect((await runInquiryPurge(fixedClock(past))).sort()).toEqual([dead.id, recent.id].sort());
  });

  /**
   * D-06. The trail outlives the row it points at, and that is the end state
   * this feature is for: an auditor sees that somebody was handled, and cannot
   * say who.
   */
  it('leaves a timeline that names an id and no person', async () => {
    const { dead } = await seedQuarter();
    await runInquiryPurge(fixedClock(past));

    const trail = await prisma.auditEvent.findMany({
      where: { resourceId: dead.id },
      orderBy: { at: 'asc' },
      select: { action: true, reason: true, actorId: true, clientId: true },
    });
    expect(trail).toEqual([
      { action: 'discard', reason: 'discarded:no_answer', actorId: desk.id, clientId: null },
      { action: 'discard', reason: 'purged', actorId: 'system', clientId: null },
    ]);
    expect(await prisma.inquiry.findUnique({ where: { id: dead.id } })).toBeNull();
  });

  it('never writes an inquiry id into the column that means a client record', async () => {
    await seedQuarter();
    await listInquiries(actor(desk));
    await updateInquiry(actor(desk), (await seedQuarter()).open.id, { note: 'rang back' });
    await runInquiryPurge(fixedClock(past));

    const rows = await prisma.auditEvent.findMany({ where: { resource: 'inquiry' } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.clientId === null)).toBe(true);
  });
});

/**
 * P0-1, checked structurally, because the invariant is about code nobody has
 * written yet. Every relation below is a path by which something clinical could
 * reach a row that is designed to be destroyed — or by which a purge could take
 * a note with it. There is no column for any of them, and this is what fails
 * the build the day somebody adds one.
 */
const CLINICAL_MODELS = [
  'ProgressNote', 'ProcessNote', 'FormRequest', 'FormSubmission',
  'Alert', 'Appointment', 'PortalLink', 'OutboxMessage',
] as const;

const modelBlock = (schema: string, name: string) => {
  const start = schema.indexOf(`model ${name} {`);
  return start === -1 ? '' : schema.slice(start, schema.indexOf('\n}', start));
};

it('has no relation in either direction between an inquiry and anything clinical', () => {
  const schema = readSource('prisma/schema.prisma');
  const inquiry = modelBlock(schema, 'Inquiry');
  expect(inquiry).not.toBe('');
  for (const model of CLINICAL_MODELS) {
    expect(inquiry, `Inquiry -> ${model}`).not.toContain(model);
    expect(modelBlock(schema, model), `${model} -> Inquiry`).not.toMatch(/\bInquiry\b/);
  }
});

it('has no query joining an inquiry to anything clinical', () => {
  const delegates = CLINICAL_MODELS.map((m) => m[0]!.toLowerCase() + m.slice(1));
  const offenders: string[] = [];

  for (const path of sourceFiles()) {
    const src = readSource(path);
    for (const m of src.matchAll(/\b(?:prisma|tx|t)\.(\w+)\.\w+/g)) {
      const delegate = m[1]!;
      const args = callArgs(src, (m.index ?? 0) + m[0].length);
      const joins =
        (delegate === 'inquiry' && delegates.some((d) => args.includes(d))) ||
        (delegates.includes(delegate) && /\binquiry/i.test(args));
      if (joins) offenders.push(`${path}: ${m[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
