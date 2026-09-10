import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, fixedClock } from '../clock';
import { prisma } from '../db';
import { Conflict, Forbidden } from '../errors';
import { intakeForm } from '../forms/fixtures';
import { ReferralSource as PrismaReferralSource } from '../generated/prisma/enums';
import { actor, makeClient, makeUser, resetDb, settings } from '../test/harness';
import { callArgs, readSource, sourceFiles } from '../test/source';
import {
  assertTransition, assignInquiry, canTransition, clinicianCapacity, convertInquiry, createInquiry,
  createReferrer, discardInquiry, listInquiries, listReferrers, previewInquiryPurge,
  runInquiryPurge, setCapacity, setReferrerActive, TRANSITIONS,
  updateInquiry, type InquiryStatus, type ReferralSource,
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

  describe('per-reason windows (P2)', () => {
    const at = (days: number) => fixedClock(new Date(new Date(T0).getTime() + days * DAY));

    it('purges spam on its own 7-day window, well inside the 90-day general one', async () => {
      const clock = fixedClock(T0);
      const spam = await anInquiry({ firstName: 'Spam' });
      await discardInquiry(actor(desk), spam.id, 'spam', { clock });
      const generic = await anInquiry({ firstName: 'Generic' });
      await discardInquiry(actor(desk), generic.id, 'no_answer', { clock });

      expect(await runInquiryPurge(at(10))).toEqual([spam.id]);
    });

    it('keeps referred_out past the general window until its own 365 days pass', async () => {
      const clock = fixedClock(T0);
      const referred = await anInquiry({ firstName: 'Referred' });
      await discardInquiry(actor(desk), referred.id, 'referred_out', { clock });

      expect(await runInquiryPurge(at(100))).toEqual([]);
      expect(await runInquiryPurge(at(366))).toEqual([referred.id]);
    });

    it('honors a settings override on a per-reason window, same as the general one', async () => {
      const clock = fixedClock(T0);
      const spam = await anInquiry({ firstName: 'Spam' });
      await discardInquiry(actor(desk), spam.id, 'spam', { clock });
      await settings({ spamRetentionDays: 30 });

      expect(await runInquiryPurge(at(10))).toEqual([]);
      expect(await runInquiryPurge(at(40))).toEqual([spam.id]);
    });
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

  describe('the preview (P1-4)', () => {
    it('names exactly what the next sweep would destroy, and destroys nothing', async () => {
      const { dead } = await seedQuarter();

      const preview = await previewInquiryPurge(actor(desk), { clock: fixedClock(past) });
      expect(preview.map((r) => r.id)).toEqual([dead.id]);
      expect(await prisma.inquiry.count()).toBe(4);
    });

    it('agrees with the purge it previews, run for run', async () => {
      const { dead, recent } = await seedQuarter();
      await settings({ inquiryRetentionDays: 1 });

      const preview = (await previewInquiryPurge(actor(desk), { clock: fixedClock(past) })).map((r) => r.id).sort();
      const purged = (await runInquiryPurge(fixedClock(past))).sort();
      expect(preview).toEqual([dead.id, recent.id].sort());
      expect(preview).toEqual(purged);
    });

    it('reads under the same cell listInquiries does — no caseload scoping, no new authorization', async () => {
      const clinician = await makeUser('therapist');
      await seedQuarter();
      await expect(previewInquiryPurge(actor(clinician), { clock: fixedClock(past) })).resolves.not.toThrow();
    });
  });
});

describe('conversion', () => {
  let admin: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
    admin = await makeUser('admin');
  });

  const convert = (
    who: Awaited<ReturnType<typeof makeUser>>,
    id: string,
    over: Record<string, unknown> = {},
  ) =>
    convertInquiry(actor(who), id, {
      code: 'TC-900', dateOfBirth: new Date('1988-03-02'),
      treatingClinicianId: therapist.id, ...over,
    });

  it('captures the two facts a phone call cannot, and carries the rest across', async () => {
    const inq = await anInquiry({ referralNote: 'Dr Okafor at the health centre' });
    const client = await convert(desk, inq.id);

    expect(client).toMatchObject({
      code: 'TC-900',
      firstName: 'A', lastName: 'Caller', phone: '(555) 010-0100',
      treatingClinicianId: therapist.id,
      // The same fact, now at the tier the business report reads (P0-9, D-04).
      referralSource: 'gp', referralNote: 'Dr Okafor at the health centre',
    });
    expect(client.dateOfBirth).toEqual(new Date('1988-03-02'));
  });

  it('keeps the inquiry, pointing at the client it became', async () => {
    const inq = await anInquiry();
    const client = await convert(desk, inq.id);

    const after = await prisma.inquiry.findUniqueOrThrow({ where: { id: inq.id } });
    expect(after).toMatchObject({ status: 'converted', clientId: client.id, discardedAt: null });
  });

  it('is one transaction: a refusal leaves no half-made client', async () => {
    const inq = await anInquiry();
    // Neither a clinician nor the practice manager has `create` on `client`, so
    // who may convert falls out of the existing matrix with no new cell.
    for (const who of [therapist, admin]) {
      await expect(convert(who, inq.id)).rejects.toThrow(Forbidden);
    }
    expect(await prisma.client.count()).toBe(0);
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: inq.id } })).status).toBe('open');
  });

  it('refuses a second ending, through the same state machine', async () => {
    const inq = await anInquiry();
    await convert(desk, inq.id);
    await expect(convert(desk, inq.id, { code: 'TC-901' })).rejects.toThrow(Conflict);
    await expect(discardInquiry(actor(desk), inq.id, 'duplicate')).rejects.toThrow(Conflict);
  });

  it('writes audit rows carrying the client id — the one inquiry row that does', async () => {
    const inq = await anInquiry();
    const client = await convert(desk, inq.id);

    const rows = await prisma.auditEvent.findMany({
      where: { OR: [{ resource: 'inquiry', action: 'update' }, { resource: 'client', action: 'create' }] },
      select: { resource: true, action: true, resourceId: true, clientId: true },
    });
    expect(rows).toHaveLength(2);
    // `clientId: null` is the rule for a row *about an inquiry*. From this
    // transaction on there is a client record, and the column means what it says.
    expect(rows.every((r) => r.clientId === client.id)).toBe(true);
    expect(rows.map((r) => r.resourceId).sort()).toEqual([client.id, inq.id].sort());
  });

  it('repoints a waitlist entry rather than making a second one', async () => {
    const inq = await anInquiry();
    const entry = await prisma.waitlistEntry.create({
      data: { inquiryId: inq.id, weekdays: [2], note: 'Tuesday evenings' },
    });
    const client = await convert(desk, inq.id);

    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    // What they wanted did not change when they became a client.
    expect(after).toMatchObject({ clientId: client.id, inquiryId: null, weekdays: [2] });
    expect(await prisma.waitlistEntry.count()).toBe(1);
  });

  it('sends nothing — the intake packet is the caller\'s next step, not a side effect', async () => {
    const inq = await anInquiry();
    await convert(desk, inq.id);
    expect(await prisma.outboxMessage.count()).toBe(0);
    expect(await prisma.formRequest.count()).toBe(0);
  });
});


/**
 * P2: assignment and capacity — one decision held by two people.
 */
describe('assignment, and the capacity signal it reads', () => {
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let alex: Awaited<ReturnType<typeof makeUser>>;
  let bea: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
    admin = await makeUser('admin');
    alex = await makeUser('therapist', { name: 'Alex' });
    bea = await makeUser('supervisor', { name: 'Bea' });
  });
  afterAll(() => prisma.$disconnect());

  it('puts a call in a queue, and takes it back out', async () => {
    const inq = await anInquiry();
    expect(inq.assignedClinicianId).toBeNull();

    expect((await assignInquiry(actor(desk), inq.id, alex.id)).assignedClinicianId).toBe(alex.id);
    // Handing it back is a real act, not a no-op — it is what puts the call
    // back on the unassigned queue where somebody will see it.
    expect((await assignInquiry(actor(desk), inq.id, null)).assignedClinicianId).toBeNull();
  });

  it('is front desk and the practice manager, and never a clinician', async () => {
    const inq = await anInquiry();
    await expect(assignInquiry(actor(therapist), inq.id, alex.id)).rejects.toThrow(Forbidden);
    // Including assigning a call to oneself: taking work is still a decision
    // about where the practice's intake goes.
    await expect(assignInquiry(actor(alex), inq.id, alex.id)).rejects.toThrow(Forbidden);
    expect((await assignInquiry(actor(admin), inq.id, alex.id)).assignedClinicianId).toBe(alex.id);
  });

  it('refuses a call that already ended, either way', async () => {
    const dead = await anInquiry();
    await discardInquiry(actor(desk), dead.id, 'no_answer');
    await expect(assignInquiry(actor(desk), dead.id, alex.id)).rejects.toThrow(Conflict);

    const converted = await anInquiry();
    await convertInquiry(actor(desk), converted.id, {
      code: 'TC-ASN', dateOfBirth: new Date('1990-01-01'), treatingClinicianId: alex.id,
    });
    await expect(assignInquiry(actor(desk), converted.id, alex.id)).rejects.toThrow(Conflict);
  });

  it('assigns to a clinician with no room — a signal, never a gate', async () => {
    await setCapacity(actor(alex), false);
    const inq = await anInquiry();
    // Somebody who rang and asked for Alex by name still goes to Alex. The
    // honest ending when the answer is really no is a `no_capacity` discard.
    expect((await assignInquiry(actor(desk), inq.id, alex.id)).assignedClinicianId).toBe(alex.id);
  });

  it('is audited as an update on the inquiry, naming no client', async () => {
    const inq = await anInquiry();
    await assignInquiry(actor(desk), inq.id, alex.id);
    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { resource: 'inquiry', action: 'update', resourceId: inq.id },
    });
    expect(row.allowed).toBe(true);
    expect(row.clientId).toBeNull();
  });

  it('lists one clinician\'s queue without narrowing what they may read', async () => {
    const hers = await anInquiry();
    const his = await anInquiry({ firstName: 'C' });
    await assignInquiry(actor(desk), hers.id, alex.id);
    await assignInquiry(actor(desk), his.id, bea.id);

    const queue = await listInquiries(actor(alex), { assignedTo: alex.id });
    expect(queue.map((i) => i.id)).toEqual([hers.id]);
    // The filter is a view, not a permission: unfiltered still returns both.
    expect((await listInquiries(actor(alex))).length).toBe(2);
  });

  it('counts caseload and queue off the rows, not off a column', async () => {
    await makeClient(alex.id);
    await makeClient(alex.id);
    const inactive = await makeClient(alex.id);
    await prisma.client.update({ where: { id: inactive.id }, data: { status: 'inactive' } });

    const waiting = await anInquiry();
    const ended = await anInquiry({ firstName: 'D' });
    await assignInquiry(actor(desk), waiting.id, alex.id);
    await assignInquiry(actor(desk), ended.id, alex.id);
    await discardInquiry(actor(desk), ended.id, 'chose_elsewhere');

    const rows = await clinicianCapacity(actor(desk));
    // Front desk is not a clinician and does not appear in a list of who can
    // take somebody new.
    expect(rows.map((r) => r.name)).toEqual(['Alex', 'Bea', therapist.name].sort());
    expect(rows.find((r) => r.id === alex.id)).toMatchObject({
      accepting: true, caseload: 2, queued: 1,
    });
  });

  it('is declared by the clinician it is about, and by nobody else', async () => {
    expect((await setCapacity(actor(alex), false)).acceptingNewClients).toBe(false);

    // There is no parameter to point at somebody else, so the matrix is asked
    // about the actor's own row and the only failing case is a role that has
    // no business declaring anybody\'s.
    for (const who of [desk, admin]) {
      await expect(setCapacity(actor(who), false)).rejects.toThrow(Forbidden);
    }
    // The practice manager\'s denial is on the record like any other.
    const denial = await prisma.auditEvent.findFirstOrThrow({
      where: { resource: 'capacity', action: 'update', allowed: false, actorId: admin.id },
    });
    expect(denial.resourceId).toBe(admin.id);
    expect(denial.clientId).toBeNull();
  });

  it('is readable by everyone who works intake, and by nobody outside it', async () => {
    for (const who of [desk, admin, alex, bea]) {
      expect((await clinicianCapacity(actor(who))).length).toBe(3);
    }
    const auditor = await makeUser('auditor');
    await expect(clinicianCapacity(actor(auditor))).rejects.toThrow(Forbidden);
  });
});

describe('referral-source detail: which practice, which doctor (P2)', () => {
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let riverside: Awaited<ReturnType<typeof createReferrer>>;
  let edService: Awaited<ReturnType<typeof createReferrer>>;

  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
    admin = await makeUser('admin');
    riverside = await createReferrer(actor(desk), { practice: 'Riverside Surgery', name: 'Dr Patel' });
    edService = await createReferrer(actor(desk), { practice: 'County ED Service' });
  });
  afterAll(() => prisma.$disconnect());

  it('turns a code into an entity: a gp referral names the surgery', async () => {
    const inq = await anInquiry({ referralSource: 'gp', referrerId: riverside.id });
    expect(inq).toMatchObject({ referralSource: 'gp', referrerId: riverside.id });
  });

  it('drops the surgery when the source is not a gp referral', async () => {
    // The picker cannot hide itself without JavaScript, so a change of mind on
    // the source above must not leave a surgery attached to "found us online".
    const inq = await anInquiry({ referralSource: 'search', referrerId: riverside.id });
    expect(inq.referrerId).toBeNull();
  });

  it('and the database refuses the disagreeing row outright, not just the service', async () => {
    // The one that matters: the invariant is a CHECK, so a hand-rolled write
    // that never passes through `createInquiry` is refused too.
    await expect(
      prisma.inquiry.create({
        data: {
          firstName: 'A', lastName: 'Caller', referralSource: 'friend', referrerId: riverside.id,
        },
      }),
    ).rejects.toThrow(/inquiry_referrer_only_for_gp/);
  });

  it('leaves an existing surgery alone on an edit that does not touch the source', async () => {
    const inq = await anInquiry({ referralSource: 'gp', referrerId: riverside.id });
    const edited = await updateInquiry(actor(desk), inq.id, { note: 'Mornings only' });
    expect(edited.referrerId).toBe(riverside.id);
  });

  it('clears it when an edit moves the source off gp', async () => {
    const inq = await anInquiry({ referralSource: 'gp', referrerId: riverside.id });
    const edited = await updateInquiry(actor(desk), inq.id, { referralSource: 'friend' });
    expect(edited.referrerId).toBeNull();
  });

  it('records where a referred-out caller was sent', async () => {
    const inq = await anInquiry();
    const out = await discardInquiry(actor(desk), inq.id, 'referred_out', {
      referredOutToId: edService.id,
    });
    expect(out).toMatchObject({ discardReason: 'referred_out', referredOutToId: edService.id });
  });

  it('ignores a destination on any other reason', async () => {
    const inq = await anInquiry();
    const out = await discardInquiry(actor(desk), inq.id, 'no_answer', {
      referredOutToId: edService.id,
    });
    expect(out.referredOutToId).toBeNull();
  });

  it('and the database refuses that combination too', async () => {
    const inq = await anInquiry();
    await expect(
      prisma.inquiry.update({
        where: { id: inq.id },
        data: { status: 'discarded', discardReason: 'spam', discardedAt: new Date(), referredOutToId: edService.id },
      }),
    ).rejects.toThrow(/inquiry_referred_out_has_a_reason/);
  });

  it('never lets the public form name a surgery — it holds no cell here', async () => {
    const stranger = { id: 'anon', role: 'public' as const };
    await expect(createReferrer(stranger, { practice: 'Anything At All' })).rejects.toThrow(Forbidden);
    await expect(listReferrers(stranger)).rejects.toThrow(Forbidden);

    // And the denial is on the record, like every other one.
    const denial = await prisma.auditEvent.findFirstOrThrow({
      where: { resource: 'referrer', action: 'create', allowed: false },
    });
    expect(denial.actorId).toBe('anon');
  });

  it('lets a clinician add one and not retire one', async () => {
    const added = await createReferrer(actor(therapist), { practice: 'Hillside Family Practice' });
    expect(added.active).toBe(true);
    await expect(setReferrerActive(actor(therapist), added.id, false)).rejects.toThrow(Forbidden);
  });

  it('retires rather than deletes, and keeps the enquiries pointing at it', async () => {
    const inq = await anInquiry({ referralSource: 'gp', referrerId: riverside.id });
    const retired = await setReferrerActive(actor(admin), riverside.id, false);
    expect(retired.active).toBe(false);

    // Still listed, still named by the row that points at it. A surgery that
    // closed its list this June is not a reason to rewrite last March.
    const all = await listReferrers(actor(desk));
    expect(all.map((r) => r.id)).toContain(riverside.id);
    expect(await listReferrers(actor(desk), { activeOnly: true })).toHaveLength(1);
    expect((await listInquiries(actor(desk))).find((r) => r.id === inq.id)?.referrerId)
      .toBe(riverside.id);
  });

  it('and the database refuses to delete one an enquiry still points at', async () => {
    await anInquiry({ referralSource: 'gp', referrerId: riverside.id });
    await expect(prisma.referrer.delete({ where: { id: riverside.id } })).rejects.toThrow();
  });

  it('survives the purge that destroys the enquiries pointing at it', async () => {
    // The directory is a contact list, not a record of a caller. The window
    // that destroys the enquiry has nothing to say about the surgery.
    const inq = await anInquiry({ referralSource: 'gp', referrerId: riverside.id });
    const clock = fixedClock(T0);
    await discardInquiry(actor(desk), inq.id, 'not_a_fit', { clock });

    const later = fixedClock(new Date(new Date(T0).getTime() + 200 * DAY).toISOString());
    expect(await runInquiryPurge(later)).toContain(inq.id);
    expect(await prisma.referrer.findUnique({ where: { id: riverside.id } })).not.toBeNull();
  });
});

describe('the waitlist accepts an inquiry (P0-7)', () => {
  beforeEach(async () => {
    await resetDb();
    await settings();
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
  });

  it('refuses an entry that names both, and one that names neither', async () => {
    const inq = await anInquiry();
    const client = await prisma.client.create({
      data: {
        code: 'TC-500', firstName: 'A', lastName: 'Client',
        dateOfBirth: new Date('1990-01-01'), treatingClinicianId: therapist.id,
      },
    });

    await expect(
      prisma.waitlistEntry.create({ data: { clientId: client.id, inquiryId: inq.id } }),
    ).rejects.toThrow(/waitlist_entry_client_xor_inquiry/);
    await expect(
      prisma.waitlistEntry.create({ data: { weekdays: [2] } }),
    ).rejects.toThrow(/waitlist_entry_client_xor_inquiry/);
  });

  /**
   * The schema's only cascade, and the reason the purge does not have to know
   * this table exists. A waitlist entry for a person who no longer exists is
   * not a thing.
   */
  it('takes the entry with the inquiry when the purge destroys it', async () => {
    const inq = await anInquiry();
    await prisma.waitlistEntry.create({ data: { inquiryId: inq.id, weekdays: [2] } });
    await discardInquiry(actor(desk), inq.id, 'no_capacity', { clock: fixedClock(T0) });

    await runInquiryPurge(fixedClock(new Date(new Date(T0).getTime() + 91 * DAY)));
    expect(await prisma.waitlistEntry.count()).toBe(0);
  });

  it('holds the entry while the inquiry is still open — the cascade is not a delete path', async () => {
    const inq = await anInquiry();
    await prisma.waitlistEntry.create({ data: { inquiryId: inq.id } });
    await expect(rawDelete(inq.id)).rejects.toThrow(/only be deleted once discarded/);
    expect(await prisma.waitlistEntry.count()).toBe(1);
  });
});

/**
 * P0-9. Options in a form template are data and change without a deploy; this
 * enum is schema and does not. Without this test they drift, and the drift is
 * invisible until a report has a category the form cannot produce.
 */
it('has a ReferralSource enum equal to the intake form\'s referral options', () => {
  const referral = intakeForm.schema.fields.find((f) => f.key === 'referral');
  expect(referral?.options).toBeDefined();
  expect(Object.values(PrismaReferralSource)).toEqual(referral!.options!.map((o) => o.value));

  // And the hand-written union in `inquiry.ts` says the same thing. This line
  // is the assertion: it stops compiling the day the enum gains a value the
  // union does not have.
  const both: ReferralSource[] = Object.values(PrismaReferralSource);
  expect(both).toHaveLength(4);
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
