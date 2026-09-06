import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, HOUR } from '../clock';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { actor, makeClient, makeRoom, makeUser, resetDb, settings } from '../test/harness';
import { bookAppointment } from './booking';
import { attendanceSummary, canTransition, cancelAppointment, classifyCancellation, setStatus, TRANSITIONS, waiveFee, type Status } from './lifecycle';

const TUESDAY = '2026-09-01';
const THREE_PM = 15 * 60;
/** 2026-09-01 15:00 America/New_York is 19:00 UTC. */
const SESSION_START = new Date('2026-09-01T19:00:00Z');

describe('the state machine (pure)', () => {
  it('walks the happy path', () => {
    const path: Status[] = ['scheduled', 'confirmed', 'arrived', 'in_session', 'completed'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('treats every ending as terminal', () => {
    for (const s of ['completed', 'no_show', 'cancelled', 'late_cancelled'] as Status[]) {
      expect(TRANSITIONS[s]).toEqual([]);
    }
  });

  it('refuses to skip or reverse', () => {
    expect(canTransition('scheduled', 'in_session')).toBe(false);
    expect(canTransition('scheduled', 'completed')).toBe(false);
    expect(canTransition('completed', 'scheduled')).toBe(false);
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
    expect(canTransition('in_session', 'cancelled')).toBe(false);
  });
});

describe('the late-cancel window (pure)', () => {
  const start = new Date('2026-09-01T19:00:00Z');

  it('is advance notice outside the window', () => {
    expect(classifyCancellation(start, new Date(start.getTime() - 25 * HOUR), 24)).toBe('cancelled');
  });

  it('is late inside the window', () => {
    expect(classifyCancellation(start, new Date(start.getTime() - 23 * HOUR), 24)).toBe('late_cancelled');
  });

  it('is late exactly on the boundary — the client had 24 hours, not 24 hours and a moment', () => {
    expect(classifyCancellation(start, new Date(start.getTime() - 24 * HOUR), 24)).toBe('cancelled');
    expect(classifyCancellation(start, new Date(start.getTime() - 24 * HOUR + 1), 24)).toBe('late_cancelled');
  });

  it('is late after the session should have started', () => {
    expect(classifyCancellation(start, new Date(start.getTime() + HOUR), 24)).toBe('late_cancelled');
  });

  it('follows a configured window', () => {
    expect(classifyCancellation(start, new Date(start.getTime() - 30 * HOUR), 48)).toBe('late_cancelled');
  });
});

describe('against the database', () => {
  let desk: Awaited<ReturnType<typeof makeUser>>;
  let therapist: Awaited<ReturnType<typeof makeUser>>;
  let client: Awaited<ReturnType<typeof makeClient>>;

  beforeEach(async () => {
    await resetDb();
    await settings({ lateCancelWindowHours: 24, lateCancelFeeCents: 9000, standardFeeCents: 18000 });
    await makeRoom('Room 1');
    desk = await makeUser('front_desk');
    therapist = await makeUser('therapist');
    client = await makeClient(therapist.id);
    await prisma.availability.create({ data: { userId: therapist.id, weekday: 2, startMinute: 540, endMinute: 1020 } });
  });
  afterAll(() => prisma.$disconnect());

  const book = () =>
    bookAppointment(actor(desk), {
      clientId: client.id, clinicianId: therapist.id, date: TUESDAY,
      startMinute: THREE_PM, type: 'standard', modality: 'in_person',
    });

  it('charges nothing for an advance cancellation', async () => {
    const appt = await book();
    const clock = fixedClock(new Date(SESSION_START.getTime() - 48 * HOUR));
    const out = await cancelAppointment(actor(desk), appt.id, { reason: 'client rescheduled', clock });
    expect(out.status).toBe('cancelled');
    expect(out.chargeFeeCents).toBeNull();
    expect(out.cancelledById).toBe(desk.id);
  });

  it('charges the policy fee for a late cancellation', async () => {
    const appt = await book();
    const clock = fixedClock(new Date(SESSION_START.getTime() - 3 * HOUR));
    const out = await cancelAppointment(actor(desk), appt.id, { clock });
    expect(out.status).toBe('late_cancelled');
    expect(out.chargeFeeCents).toBe(9000);
  });

  it('charges the client sliding-scale fee on completion, not the standard one', async () => {
    const reduced = await makeClient(therapist.id, { feeCents: 6000 });
    const appt = await bookAppointment(actor(desk), {
      clientId: reduced.id, clinicianId: therapist.id, date: TUESDAY,
      startMinute: 600, type: 'standard', modality: 'in_person',
    });
    await setStatus(actor(desk), appt.id, 'arrived');
    await setStatus(actor(desk), appt.id, 'in_session');
    const done = await setStatus(actor(desk), appt.id, 'completed');
    expect(done.chargeFeeCents).toBe(6000);
  });

  it('refuses an illegal transition', async () => {
    const appt = await book();
    await expect(setStatus(actor(desk), appt.id, 'completed')).rejects.toMatchObject({ code: 'bad_transition' });
    await setStatus(actor(desk), appt.id, 'cancelled');
    await expect(setStatus(actor(desk), appt.id, 'confirmed')).rejects.toMatchObject({ code: 'bad_transition' });
  });

  it('frees the room and the clinician once cancelled', async () => {
    const first = await book();
    await cancelAppointment(actor(desk), first.id, { clock: fixedClock(new Date(SESSION_START.getTime() - 48 * HOUR)) });
    const second = await book();
    expect(second.id).not.toBe(first.id);
  });

  it('keeps the slot blocked for a no-show — the hour was still spent', async () => {
    const appt = await book();
    await setStatus(actor(desk), appt.id, 'no_show');
    await expect(book()).rejects.toMatchObject({ code: 'clinician_busy' });
  });

  describe('attendance counts', () => {
    const history = async () => {
      const early = fixedClock(new Date(SESSION_START.getTime() - 48 * HOUR));
      const late = fixedClock(new Date(SESSION_START.getTime() - HOUR));
      const a = await book();
      await cancelAppointment(actor(desk), a.id, { clock: late });
      const b = await book();
      await cancelAppointment(actor(desk), b.id, { clock: early });
      const c = await book();
      await setStatus(actor(desk), c.id, 'no_show');
    };

    it('are visible to the treating clinician', async () => {
      await history();
      const summary = await attendanceSummary(actor(therapist), client.id);
      expect(summary).toMatchObject({ lateCancelled: 1, cancelled: 1, noShow: 1 });
      expect(summary.chargeableFeeCents).toBe(18000); // one late cancel + one no-show
    });

    it('are visible to the practice manager', async () => {
      const admin = await makeUser('admin');
      await expect(attendanceSummary(actor(admin), client.id)).resolves.toBeTruthy();
    });

    it('are denied to front desk, and the denial is logged', async () => {
      await expect(attendanceSummary(actor(desk), client.id)).rejects.toBeInstanceOf(Forbidden);
      const [row] = await prisma.auditEvent.findMany({ where: { resource: 'attendance_history' } });
      expect(row).toMatchObject({ allowed: false, actorRole: 'front_desk', clientId: client.id });
    });

    it('are denied to another clinician', async () => {
      const other = await makeUser('therapist');
      await expect(attendanceSummary(actor(other), client.id)).rejects.toBeInstanceOf(Forbidden);
    });
  });

  /**
   * P0-1. Confirmation and attendance are separate facts, and an attendance
   * write never speaks for the client. The second test here is the row the
   * whole confirmation feature is judged on: silent, present, charged for the
   * session and nothing more.
   */
  describe('confirmation is untouched by a status write', () => {
    it('survives the walk to completed', async () => {
      const appt = await book();
      await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation: 'pending' } });

      for (const to of ['arrived', 'in_session', 'completed'] as Status[]) {
        const out = await setStatus(actor(desk), appt.id, to);
        expect(out.confirmation, to).toBe('pending');
      }
    });

    it('does not let silence become a no-show fee for a client who turned up', async () => {
      const appt = await bookAppointment(actor(desk), {
        clientId: client.id, clinicianId: therapist.id, date: TUESDAY,
        startMinute: 16 * 60, type: 'standard', modality: 'in_person',
      });
      await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation: 'no_response' } });

      await setStatus(actor(desk), appt.id, 'arrived');
      await setStatus(actor(desk), appt.id, 'in_session');
      const out = await setStatus(actor(desk), appt.id, 'completed');

      expect(out.status).toBe('completed');
      expect(out.confirmation).toBe('no_response');
      expect(out.chargeFeeCents).toBe(18000); // the session, not the no-show policy
    });
  });
  /**
   * P0-6. Two policies, two fields. The field shipped at the late-cancel figure
   * so that the migration changed no behaviour on the day it landed (D-09) —
   * the first test here is what pins that, and it passed before the change as
   * well as after it.
   */
  describe('the no-show fee is its own money', () => {
    it('is unchanged while both fields sit at their defaults', async () => {
      const appt = await book();
      const out = await setStatus(actor(desk), appt.id, 'no_show');
      expect(out.chargeFeeCents).toBe(9000);
    });

    it('charges the no-show policy, not the late-cancel one', async () => {
      await settings({ noShowFeeCents: 18000, lateCancelFeeCents: 9000 });

      const missed = await book();
      expect((await setStatus(actor(desk), missed.id, 'no_show')).chargeFeeCents).toBe(18000);

      const bailed = await bookAppointment(actor(desk), {
        clientId: client.id, clinicianId: therapist.id, date: TUESDAY,
        startMinute: 16 * 60, type: 'standard', modality: 'in_person',
      });
      const out = await cancelAppointment(actor(desk), bailed.id, {
        clock: fixedClock(new Date(SESSION_START.getTime() - 3 * HOUR)),
      });
      expect(out.status).toBe('late_cancelled');
      expect(out.chargeFeeCents).toBe(9000);
    });

    it('keeps summing both into the chargeable total', async () => {
      await settings({ noShowFeeCents: 18000, lateCancelFeeCents: 9000 });
      const missed = await book();
      await setStatus(actor(desk), missed.id, 'no_show');
      const bailed = await bookAppointment(actor(desk), {
        clientId: client.id, clinicianId: therapist.id, date: TUESDAY,
        startMinute: 16 * 60, type: 'standard', modality: 'in_person',
      });
      await cancelAppointment(actor(desk), bailed.id, {
        clock: fixedClock(new Date(SESSION_START.getTime() - 3 * HOUR)),
      });

      const summary = await attendanceSummary(actor(therapist), client.id);
      expect(summary.chargeableFeeCents).toBe(27000);
    });

    it('is integer cents, never a float', async () => {
      const appt = await book();
      const out = await setStatus(actor(desk), appt.id, 'no_show');
      expect(Number.isInteger(out.chargeFeeCents)).toBe(true);
    });
  });

  /**
   * P0-7. An automatic charge without a reversal is not shippable. The sweep
   * can now bill a client nobody spoke to, so the reversal ships in the same
   * phase — and it is the practice manager's, not the front desk's.
   */
  describe('waiving a fee', () => {
    let admin: Awaited<ReturnType<typeof makeUser>>;
    const charged = async () => {
      const appt = await book();
      return setStatus(actor(desk), appt.id, 'no_show');
    };

    beforeEach(async () => {
      admin = await makeUser('admin');
    });

    it('zeroes the fee and records who decided, and why', async () => {
      const appt = await charged();
      const clock = fixedClock(new Date(SESSION_START.getTime() + 25 * HOUR));

      const out = await waiveFee(actor(admin), appt.id, 'goodwill', { clock });

      expect(out.chargeFeeCents).toBe(0);
      expect(out.feeWaivedById).toBe(admin.id);
      expect(out.feeWaiveReason).toBe('goodwill');
      expect(out.feeWaivedAt).toEqual(clock.now());
    });

    it('leaves the attendance record exactly as it was', async () => {
      const appt = await charged();
      await prisma.appointment.update({ where: { id: appt.id }, data: { confirmation: 'no_response' } });

      const out = await waiveFee(actor(admin), appt.id, 'client_disputed');

      // The client still did not turn up; the practice chose not to charge.
      expect(out.status).toBe('no_show');
      expect(out.confirmation).toBe('no_response');
    });

    it('leaves the original amount recoverable from the audit trail', async () => {
      const appt = await charged();
      await waiveFee(actor(admin), appt.id, 'practice_error');

      const [row] = await prisma.auditEvent.findMany({ where: { resource: 'fee', action: 'waive' } });
      expect(row).toMatchObject({
        allowed: true, actorId: admin.id, resourceId: appt.id, clientId: client.id,
        reason: 'practice_error:9000',
      });
    });

    it('is denied to front desk, and the denial is logged', async () => {
      const appt = await charged();

      await expect(waiveFee(actor(desk), appt.id, 'goodwill')).rejects.toBeInstanceOf(Forbidden);

      expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).chargeFeeCents).toBe(9000);
      const [row] = await prisma.auditEvent.findMany({ where: { resource: 'fee', action: 'waive' } });
      expect(row).toMatchObject({ allowed: false, actorRole: 'front_desk', clientId: client.id });
    });

    it('is denied to the treating clinician too — it is a management decision', async () => {
      const appt = await charged();
      await expect(waiveFee(actor(therapist), appt.id, 'emergency')).rejects.toBeInstanceOf(Forbidden);
    });

    it('refuses when there is no fee to waive', async () => {
      const appt = await book();
      await expect(waiveFee(actor(admin), appt.id, 'goodwill')).rejects.toMatchObject({ code: 'no_fee' });
    });

    it('refuses to waive the same fee twice', async () => {
      const appt = await charged();
      await waiveFee(actor(admin), appt.id, 'goodwill');
      await expect(waiveFee(actor(admin), appt.id, 'goodwill')).rejects.toMatchObject({ code: 'already_waived' });
    });
  });

});

/**
 * P0-1. `no_show` is the one status a job can now reach on its own, and it
 * carries money. So the write lives in exactly one function, where the
 * `scheduled`-only guard and the audit row are, rather than wherever the next
 * feature finds it convenient. Files with no database handle are not a way to
 * write a status, so the design gallery's chip fixture is not a violation.
 */
it('nothing outside lifecycle.ts writes a no-show status', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path === 'src/scheduling/lifecycle.ts' || path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      const src = readFileSync(path, 'utf8');
      if (!/prisma\.|tx\./.test(src)) continue;
      if (/status:\s*['"`]no_show/.test(src)) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});
