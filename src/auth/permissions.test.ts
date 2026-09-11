import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Role as PrismaRole } from '../generated/prisma/enums';
import {
  ACTIONS, RESOURCES, ROLES,
  can, ownCaseloadOnly, requiresSecondFactor,
  type Action, type Actor, type Resource, type Role, type Target,
} from './permissions';

/**
 * The expected policy, written from the PRD rather than read back off the
 * matrix, so a wrong edit to the matrix fails here instead of agreeing with
 * itself. Every role × resource × action cell NOT listed must deny for every
 * probe below.
 */
const spec = (m: Partial<Record<Resource, string>>) =>
  new Set(
    Object.entries(m).flatMap(([r, actions]) =>
      (actions as string).split(' ').map((a) => `${r}:${a}`),
    ),
  );

/** Cells that are allowed for SOMEBODY, under some relationship. */
const ALLOWED: Record<Role, Set<string>> = {
  front_desk: spec({
    client: 'read create update',
    fee: 'read',
    appointment: 'read create update',
    form_request: 'read create',
    portal_link: 'read create',
    inquiry: 'read create update discard',
    capacity: 'read',
    referrer: 'read create update',
    // Answers the phone to "who will I be seeing?". Reads only.
    departure: 'read',
    // And to "who do I talk to while Nour is away?".
    leave: 'read',
  }),
  therapist: spec({
    client: 'read update',
    fee: 'read',
    appointment: 'read create update',
    attendance_history: 'read',
    progress_note: 'read create update sign',
    process_note: 'read create update',
    form_template: 'read',
    form_request: 'read create',
    form_submission: 'read',
    alert: 'read update',
    portal_link: 'read create',
    inquiry: 'read create',
    capacity: 'read update',
    // Exactly the `inquiry` shape: name the surgery on a call you took, and
    // leave curating the list to the people who run the practice.
    referrer: 'read create',
    // `self`: your own leaving, never a colleague's.
    departure: 'read',
    // `self` again: your own absence, and not the plan you are covering under.
    leave: 'read',
  }),
  associate: spec({
    client: 'read update',
    fee: 'read',
    appointment: 'read create update',
    attendance_history: 'read',
    progress_note: 'read create update sign',
    process_note: 'read create update',
    form_template: 'read',
    form_request: 'read create',
    form_submission: 'read',
    alert: 'read update',
    portal_link: 'read create',
    inquiry: 'read create',
    capacity: 'read update',
    referrer: 'read create',
    departure: 'read',
    leave: 'read',
  }),
  supervisor: spec({
    client: 'read update',
    fee: 'read',
    appointment: 'read create update',
    attendance_history: 'read',
    progress_note: 'read create update sign cosign',
    process_note: 'read create update',
    form_template: 'read',
    form_request: 'read create',
    form_submission: 'read',
    alert: 'read update',
    portal_link: 'read create',
    inquiry: 'read create',
    capacity: 'read update',
    referrer: 'read create',
    // Reads any departure and proposes the dispositions; never executes one.
    departure: 'read update',
    // Decides who covers which client, which for a leave is the grant itself.
    leave: 'read update',
  }),
  admin: spec({
    client: 'read update', // break-glass only
    fee: 'read update waive',
    appointment: 'read create update',
    attendance_history: 'read',
    progress_note: 'read', // break-glass only
    form_template: 'read create update',
    form_request: 'read',
    portal_link: 'read create',
    user: 'read create update',
    inquiry: 'read create update discard',
    // Read, and no update anywhere in this row: the practice manager is the one
    // person who cannot declare that a clinician has room.
    capacity: 'read',
    // And this one they do hold in full — who the practice exchanges referrals
    // with is a business relationship they run, not a judgement about a
    // clinician that only that clinician can make.
    referrer: 'read create update',
    // The only holder of `depart`. Deliberately not `user.update`, which they
    // already have: same row, three orders of magnitude of blast radius.
    departure: 'read create update depart',
    // The only creator: recording a leave closes a clinician's books.
    leave: 'read create update',
  }),
  auditor: spec({ audit_log: 'read' }),
  // The tokenized door, and nothing else in the matrix. `update` is confirm and
  // decline; reading behind the link and asking for a different time change
  // nothing and stay outside this file.
  client: spec({ appointment: 'update' }),
  // The public enquiry form. One cell, and it is the whole anonymous internet.
  public: spec({ inquiry: 'create' }),
};

/** Cells allowed with NO relationship and NO break-glass. */
const UNCONDITIONAL: Record<Role, Set<string>> = {
  front_desk: ALLOWED.front_desk,
  therapist: spec({
    appointment: 'read create update',
    form_template: 'read',
    form_request: 'read create',
    inquiry: 'read create',
    // `read` only: `update` is `self`, so without a subject it decides never.
    capacity: 'read',
    // Every cell here is `always` — a contact list has no relationship to
    // hold, which is exactly why the narrow part had to be *who* holds it.
    referrer: 'read create',
  }),
  associate: spec({
    appointment: 'read create update',
    form_template: 'read',
    form_request: 'read create',
    inquiry: 'read create',
    capacity: 'read',
    referrer: 'read create',
  }),
  supervisor: spec({
    appointment: 'read create update',
    form_template: 'read',
    form_request: 'read create',
    inquiry: 'read create',
    capacity: 'read',
    referrer: 'read create',
    // `always`, both of them — a supervisor reads and shapes any departure,
    // not only one they hold a relationship to. Absent from the therapist and
    // associate blocks above because theirs is `self`.
    departure: 'read update',
    leave: 'read update',
  }),
  admin: spec({
    fee: 'read update waive',
    appointment: 'read create update',
    attendance_history: 'read',
    form_template: 'read create update',
    form_request: 'read',
    portal_link: 'read create',
    user: 'read create update',
    inquiry: 'read create update discard',
    capacity: 'read',
    referrer: 'read create update',
    departure: 'read create update depart',
    leave: 'read create update',
  }),
  auditor: ALLOWED.auditor,
  // Never unconditional: without a row that is theirs, a token decides `never`.
  client: new Set<string>(),
  // Unconditional by definition — there is no relationship to hold, which is
  // exactly why the cell had to be narrow.
  public: ALLOWED.public,
};

const ME = 'u-me';
const OTHER = 'u-other';
const TODAY = '2026-10-14';
const coveredBy = (id: string): Pick<Target, 'coverage' | 'authorSupervisorCoverage' | 'treatingSupervisorCoverage' | 'today'> => {
  const window = { leaveId: 'lv-probe', coveringClinicianId: id, fromDate: '2026-10-05', toDate: '2026-11-27' };
  return { coverage: window, authorSupervisorCoverage: window, treatingSupervisorCoverage: window, today: TODAY };
};

/** Actor holds every relationship to the target it possibly could. */
const insider = (role: Role): [Actor, Target] => [
  { id: ME, role, breakGlass: { reason: 'client in crisis' } },
  {
    authorId: ME, authorSupervisorId: ME, clinicianId: ME, recipientId: ME,
    treatingSupervisorId: ME, ownerClientId: ME, subjectUserId: ME, ...coveredBy(ME),
  },
];
/** Actor supervises the target's author but wrote nothing. */
const oversight = (role: Role): [Actor, Target] => [
  { id: ME, role },
  {
    authorId: OTHER, authorSupervisorId: ME, clinicianId: OTHER, recipientId: OTHER,
    treatingSupervisorId: ME, ownerClientId: OTHER, subjectUserId: OTHER, ...coveredBy(OTHER),
  },
];
/** Actor holds no relationship at all. */
const stranger = (role: Role): [Actor, Target] => [
  { id: ME, role },
  {
    authorId: OTHER, authorSupervisorId: OTHER, clinicianId: OTHER, recipientId: OTHER,
    treatingSupervisorId: OTHER, ownerClientId: OTHER, subjectUserId: OTHER, ...coveredBy(OTHER),
  },
];

describe('permission matrix — every cell', () => {
  const cells: [Role, Resource, Action][] = ROLES.flatMap((role) =>
    RESOURCES.flatMap((res) => ACTIONS.map((a) => [role, res, a] as [Role, Resource, Action])),
  );

  it('covers every cell', () => expect(cells).toHaveLength(ROLES.length * RESOURCES.length * ACTIONS.length));

  it.each(cells)('%s / %s / %s', (role, resource, action) => {
    const key = `${resource}:${action}`;
    const probes = [insider(role), oversight(role), stranger(role)];
    const results = probes.map(([a, t]) => can(a, action, resource, t).allowed);

    expect(results.some(Boolean), 'expected allowed for someone').toBe(
      ALLOWED[role].has(key),
    );
  });

  it.each(cells)('unconditional: %s / %s / %s', (role, resource, action) => {
    const [actor, target] = stranger(role);
    expect(can(actor, action, resource, target).allowed).toBe(
      UNCONDITIONAL[role].has(`${resource}:${action}`),
    );
  });
});

describe('process notes are author-only, forever', () => {
  const note: Target = { authorId: OTHER, authorSupervisorId: ME, clinicianId: OTHER };

  it('the author reads their own', () => {
    expect(can({ id: ME, role: 'therapist' }, 'read', 'process_note', {
      authorId: ME, clinicianId: ME,
    }).allowed).toBe(true);
  });

  it('a supervisor of the author is denied', () => {
    expect(can({ id: ME, role: 'supervisor' }, 'read', 'process_note', note).allowed).toBe(false);
  });

  it('the treating clinician, if not the author, is denied', () => {
    expect(can({ id: ME, role: 'therapist' }, 'read', 'process_note', {
      authorId: OTHER, clinicianId: ME,
    }).allowed).toBe(false);
  });

  it('the practice manager is denied, with or without a reason typed', () => {
    expect(can({ id: ME, role: 'admin' }, 'read', 'process_note', note).allowed).toBe(false);
  });

  it('break-glass is denied and still flagged for the audit log', () => {
    const d = can(
      { id: ME, role: 'admin', breakGlass: { reason: 'welfare check' } },
      'read', 'process_note', note,
    );
    expect(d).toEqual({ allowed: false, rule: 'never', breakGlass: true });
  });

  it('has no signature workflow', () => {
    for (const role of ROLES) {
      const [actor, target] = insider(role);
      expect(can(actor, 'sign', 'process_note', target).allowed).toBe(false);
      expect(can(actor, 'cosign', 'process_note', target).allowed).toBe(false);
    }
  });
});

describe('progress notes', () => {
  const supervisee: Target = { authorId: OTHER, authorSupervisorId: ME, clinicianId: OTHER };

  it("a supervisor reads their supervisee's note", () => {
    expect(can({ id: ME, role: 'supervisor' }, 'read', 'progress_note', supervisee).allowed).toBe(true);
  });

  it("a supervisor of somebody else does not", () => {
    expect(can({ id: ME, role: 'supervisor' }, 'read', 'progress_note', {
      authorId: OTHER, authorSupervisorId: 'u-third', clinicianId: OTHER,
    }).allowed).toBe(false);
  });

  it('reassigning the supervisor reroutes access and co-sign immediately', () => {
    const boss = { id: ME, role: 'supervisor' as const };
    const before: Target = { authorId: OTHER, authorSupervisorId: 'u-old' };
    const after: Target = { authorId: OTHER, authorSupervisorId: ME };
    expect(can(boss, 'cosign', 'progress_note', before).allowed).toBe(false);
    expect(can(boss, 'cosign', 'progress_note', after).allowed).toBe(true);
  });

  it('nobody co-signs their own note', () => {
    expect(can({ id: ME, role: 'supervisor' }, 'cosign', 'progress_note', {
      authorId: ME, authorSupervisorId: ME,
    }).allowed).toBe(false);
  });

  it('an associate cannot co-sign', () => {
    expect(can({ id: ME, role: 'associate' }, 'cosign', 'progress_note', supervisee).allowed).toBe(false);
  });

  it('break-glass reaches it, flagged', () => {
    const d = can(
      { id: ME, role: 'admin', breakGlass: { reason: 'subpoena response' } },
      'read', 'progress_note', supervisee,
    );
    expect(d).toEqual({ allowed: true, rule: 'breakGlass', breakGlass: true });
  });
});

describe('the official record follows the client (D-04)', () => {
  it('the author reads their own, whoever treats the client now', () => {
    const d = can({ id: ME, role: 'therapist' }, 'read', 'progress_note', {
      authorId: ME, authorSupervisorId: OTHER, clinicianId: OTHER,
    });
    expect(d.allowed).toBe(true);
    // The rule name goes in the audit row, so it is part of the contract. The
    // cell gained a fourth claimant with clinician leave (leave D-04), and the
    // name says so; the author's read is not attributed to any leave.
    expect(d.rule).toBe('authorSupervisorTreatingOrCovering');
    expect(d.coveringLeaveId).toBeUndefined();
  });

  it('the clinician who carries the client now reads what the last one wrote', () => {
    expect(can({ id: ME, role: 'therapist' }, 'read', 'progress_note', {
      authorId: OTHER, authorSupervisorId: OTHER, clinicianId: ME,
    }).allowed).toBe(true);
  });

  it('the supervisor of the author still reads it', () => {
    expect(can({ id: ME, role: 'supervisor' }, 'read', 'progress_note', {
      authorId: OTHER, authorSupervisorId: ME, clinicianId: OTHER,
    }).allowed).toBe(true);
  });

  it('a clinician who neither wrote it, supervises it, nor treats the client does not', () => {
    for (const role of ['therapist', 'associate', 'supervisor'] as Role[]) {
      const [actor, target] = stranger(role);
      expect(can(actor, 'read', 'progress_note', target).allowed).toBe(false);
    }
  });

  it('widens reading only — writing, signing and co-signing are where they were', () => {
    const inherited: Target = { authorId: OTHER, authorSupervisorId: OTHER, clinicianId: ME };
    const beth: Actor = { id: ME, role: 'therapist' };
    // She may write her OWN note about this client, and may not touch his.
    expect(can(beth, 'create', 'progress_note', inherited).allowed).toBe(true);
    expect(can(beth, 'update', 'progress_note', inherited).allowed).toBe(false);
    expect(can(beth, 'sign', 'progress_note', inherited).allowed).toBe(false);
    expect(can(beth, 'cosign', 'progress_note', inherited).allowed).toBe(false);
  });

  it('gives the practice manager and front desk nothing new', () => {
    const inherited: Target = { authorId: OTHER, authorSupervisorId: OTHER, clinicianId: ME };
    expect(can({ id: ME, role: 'admin' }, 'read', 'progress_note', inherited).allowed).toBe(false);
    expect(can({ id: ME, role: 'front_desk' }, 'read', 'progress_note', inherited).allowed).toBe(false);
  });

  it('and the private notes give the same reader the opposite answer', () => {
    // The single assertion this whole feature exists to make: one client, one
    // clinician, one moment — the practice's record of care transfers, and the
    // therapist's private working notes never did belong to it.
    const inherited: Target = { authorId: OTHER, authorSupervisorId: OTHER, clinicianId: ME };
    const beth: Actor = { id: ME, role: 'therapist' };
    expect(can(beth, 'read', 'progress_note', inherited).allowed).toBe(true);
    expect(can(beth, 'read', 'process_note', inherited).allowed).toBe(false);
  });
});

describe('departure is its own resource, and `depart` its own action', () => {
  const plan: Target = { subjectUserId: OTHER };

  it('the practice manager plans it and is the only one who executes it', () => {
    const ray: Actor = { id: ME, role: 'admin' };
    for (const action of ['read', 'create', 'update', 'depart'] as Action[]) {
      expect(can(ray, action, 'departure', plan).allowed).toBe(true);
    }
  });

  it('nobody else may execute one — not even with every relationship claimed', () => {
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      const [actor, target] = insider(role);
      expect(can(actor, 'depart', 'departure', target).allowed, role).toBe(false);
    }
  });

  it('a supervisor shapes the plan and cannot pull the trigger', () => {
    const sam: Actor = { id: ME, role: 'supervisor' };
    expect(can(sam, 'read', 'departure', plan).allowed).toBe(true);
    expect(can(sam, 'update', 'departure', plan).allowed).toBe(true);
    expect(can(sam, 'create', 'departure', plan).allowed).toBe(false);
    expect(can(sam, 'depart', 'departure', plan).allowed).toBe(false);
  });

  it('front desk reads it to answer the phone, and writes none of it', () => {
    const dana: Actor = { id: ME, role: 'front_desk' };
    expect(can(dana, 'read', 'departure', plan).allowed).toBe(true);
    for (const action of ACTIONS.filter((a) => a !== 'read')) {
      expect(can(dana, action, 'departure', plan).allowed, action).toBe(false);
    }
  });

  it('a clinician reads their own leaving and never a colleague’s', () => {
    for (const role of ['therapist', 'associate'] as Role[]) {
      const alex: Actor = { id: ME, role };
      expect(can(alex, 'read', 'departure', { subjectUserId: ME }).allowed).toBe(true);
      expect(can(alex, 'read', 'departure', { subjectUserId: OTHER }).allowed).toBe(false);
      // And a missing subject is never a match, the way `capacity` is not.
      expect(can(alex, 'read', 'departure', {}).allowed).toBe(false);
    }
  });

  it('holds no break-glass cell anywhere — there is no clinical content in it', () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        const withGlass: Actor = { id: ME, role, breakGlass: { reason: 'caseload review' } };
        const without: Actor = { id: ME, role };
        const t: Target = { subjectUserId: OTHER };
        expect(
          can(withGlass, action, 'departure', t).allowed,
          `${role}:${action}`,
        ).toBe(can(without, action, 'departure', t).allowed);
      }
    }
  });

  it('is not reachable by the auditor, the client link, or the public form', () => {
    for (const role of ['auditor', 'client', 'public'] as Role[]) {
      for (const action of ACTIONS) {
        const [actor, target] = insider(role);
        expect(can(actor, action, 'departure', target).allowed, `${role}:${action}`).toBe(false);
      }
    }
  });

  it('`depart` reaches nothing but a departure', () => {
    for (const resource of RESOURCES.filter((r) => r !== 'departure')) {
      for (const role of ROLES) {
        const [actor, target] = insider(role);
        expect(can(actor, 'depart', resource, target).allowed, `${role}:${resource}`).toBe(false);
      }
    }
  });
});

describe('leave is its own resource, with no action of its own', () => {
  const plan: Target = { subjectUserId: OTHER };

  it('the practice manager records it, and nobody else creates one', () => {
    const ray: Actor = { id: ME, role: 'admin' };
    for (const action of ['read', 'create', 'update'] as Action[]) {
      expect(can(ray, action, 'leave', plan).allowed).toBe(true);
    }
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      const [actor, target] = insider(role);
      expect(can(actor, 'create', 'leave', target).allowed, role).toBe(false);
    }
  });

  it('a supervisor decides who covers, and cannot record a leave', () => {
    const sam: Actor = { id: ME, role: 'supervisor' };
    expect(can(sam, 'read', 'leave', plan).allowed).toBe(true);
    expect(can(sam, 'update', 'leave', plan).allowed).toBe(true);
    expect(can(sam, 'create', 'leave', plan).allowed).toBe(false);
  });

  it('front desk reads it to answer the phone, and writes none of it', () => {
    const dana: Actor = { id: ME, role: 'front_desk' };
    expect(can(dana, 'read', 'leave', plan).allowed).toBe(true);
    for (const action of ACTIONS.filter((a) => a !== 'read')) {
      expect(can(dana, action, 'leave', plan).allowed, action).toBe(false);
    }
  });

  it('a clinician reads their own absence — not a colleague’s, not even the one they cover', () => {
    for (const role of ['therapist', 'associate'] as Role[]) {
      const dev: Actor = { id: ME, role };
      expect(can(dev, 'read', 'leave', { subjectUserId: ME }).allowed).toBe(true);
      expect(can(dev, 'read', 'leave', { subjectUserId: OTHER }).allowed).toBe(false);
      expect(can(dev, 'read', 'leave', { subjectUserId: OTHER, ...coveredBy(ME) }).allowed).toBe(false);
      expect(can(dev, 'read', 'leave', {}).allowed).toBe(false);
    }
  });

  it('holds no break-glass cell anywhere — the row stores no reason to reach', () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        const withGlass: Actor = { id: ME, role, breakGlass: { reason: 'caseload review' } };
        const without: Actor = { id: ME, role };
        expect(can(withGlass, action, 'leave', plan).allowed, `${role}:${action}`)
          .toBe(can(without, action, 'leave', plan).allowed);
      }
    }
  });

  it('is not reachable by the auditor, the client link, or the public form', () => {
    for (const role of ['auditor', 'client', 'public'] as Role[]) {
      for (const action of ACTIONS) {
        const [actor, target] = insider(role);
        expect(can(actor, action, 'leave', target).allowed, `${role}:${action}`).toBe(false);
      }
    }
  });

  it('answers nothing but read, create and update, for anybody', () => {
    for (const action of ['sign', 'cosign', 'waive', 'discard', 'depart'] as Action[]) {
      for (const role of ROLES) {
        const [actor, target] = insider(role);
        expect(can(actor, action, 'leave', target).allowed, `${role}:${action}`).toBe(false);
      }
    }
  });
});

describe('coverage is a second reader for a dated window (leave D-02, D-04, D-14)', () => {
  const NOUR = 'u-nour';
  const DEV = 'u-dev';
  const KAI = 'u-kai';
  const SAM = 'u-sam'; // Nour's supervisor
  const DEVS_SUPERVISOR = 'u-devs-supervisor';
  const LEAVE: NonNullable<Target['coverage']> = {
    leaveId: 'lv-nour', coveringClinicianId: DEV, fromDate: '2026-10-05', toDate: '2026-11-27',
  };
  /** A client of Nour's, a note Nour wrote about them, and an alert addressed to Nour — on `today`. */
  const onDay = (today: string, coverage: Target['coverage'] = LEAVE): Target => ({
    clinicianId: NOUR, treatingSupervisorId: SAM, authorId: NOUR, authorSupervisorId: SAM,
    recipientId: NOUR, coverage, today,
  });
  const as = (id: string, role: Role = 'therapist'): Actor => ({ id, role });

  const GAINED: [Resource, Action][] = [
    ['client', 'read'], ['form_submission', 'read'], ['progress_note', 'read'],
    ['progress_note', 'create'], ['process_note', 'create'],
  ];
  const UNMOVED: [Resource, Action][] = [
    ['client', 'update'], ['fee', 'read'], ['attendance_history', 'read'],
    ['portal_link', 'read'], ['portal_link', 'create'], ['alert', 'read'], ['alert', 'update'],
    ['progress_note', 'update'], ['progress_note', 'sign'], ['progress_note', 'cosign'],
    ['process_note', 'read'], ['process_note', 'update'],
  ];
  const COVERER_ROLES: Role[] = ['therapist', 'supervisor'];

  it.each(GAINED)('the coverer gains %s / %s on the first day and on the last', (resource, action) => {
    for (const role of COVERER_ROLES) {
      expect(can(as(DEV, role), action, resource, onDay('2026-10-05')).allowed, role).toBe(true);
      expect(can(as(DEV, role), action, resource, onDay('2026-11-27')).allowed, role).toBe(true);
    }
  });

  it.each(GAINED)('and holds no %s / %s the day before, the day after, once cancelled, or after an early return', (resource, action) => {
    const dev = as(DEV);
    expect(can(dev, action, resource, onDay('2026-10-04')).allowed, 'day before').toBe(false);
    expect(can(dev, action, resource, onDay('2026-11-28')).allowed, 'day after').toBe(false);
    const cancelled = { ...LEAVE, cancelledAt: new Date('2026-09-20T15:00:00Z') };
    expect(can(dev, action, resource, onDay('2026-10-14', cancelled)).allowed, 'cancelled').toBe(false);
    const cameBack = { ...LEAVE, toDate: '2026-10-20' };
    expect(can(dev, action, resource, onDay('2026-10-20', cameBack)).allowed, 'return day').toBe(true);
    expect(can(dev, action, resource, onDay('2026-10-21', cameBack)).allowed, 'after return').toBe(false);
  });

  it.each(UNMOVED)('never gains %s / %s, on any day of the leave', (resource, action) => {
    for (const role of COVERER_ROLES) {
      for (const day of ['2026-10-05', '2026-10-14', '2026-11-27']) {
        expect(can(as(DEV, role), action, resource, onDay(day)).allowed, `${role} ${day}`).toBe(false);
      }
    }
  });

  it('admits only the coverer the target names — a client split to Kai admits Kai, not Dev', () => {
    const split = onDay('2026-10-14', { ...LEAVE, coveringClinicianId: KAI });
    for (const [resource, action] of GAINED) {
      expect(can(as(KAI), action, resource, split).allowed, `${resource}:${action}`).toBe(true);
      expect(can(as(DEV), action, resource, split).allowed, `${resource}:${action}`).toBe(false);
    }
  });

  it('gives the coverer’s own supervisor nothing the coverer gained', () => {
    const theirs = as(DEVS_SUPERVISOR, 'supervisor');
    for (const [resource, action] of GAINED) {
      expect(can(theirs, action, resource, onDay('2026-10-14')).allowed, `${resource}:${action}`).toBe(false);
    }
  });

  it('never makes an associate a coverer, even with the row in hand (D-13)', () => {
    for (const [resource, action] of GAINED) {
      expect(can(as(DEV, 'associate'), action, resource, onDay('2026-10-14')).allowed, `${resource}:${action}`).toBe(false);
    }
  });

  it('changes nothing for a role outside the clinical row, break-glass included', () => {
    for (const role of ['front_desk', 'admin', 'auditor', 'client', 'public'] as Role[]) {
      for (const breakGlass of [undefined, { reason: 'client in crisis' }]) {
        const named: Actor = { id: DEV, role, breakGlass };
        for (const resource of RESOURCES) {
          for (const action of ACTIONS) {
            expect(
              can(named, action, resource, onDay('2026-10-14')).allowed,
              `${role}:${resource}:${action}`,
            ).toBe(can(named, action, resource, onDay('2026-10-14', undefined)).allowed);
          }
        }
      }
    }
  });

  it('fails closed: a target built without coverage, or without today, denies the coverer', () => {
    const { coverage: _c, ...noCoverage } = onDay('2026-10-14');
    const { today: _t, ...noToday } = onDay('2026-10-14');
    for (const [resource, action] of GAINED) {
      expect(can(as(DEV), action, resource, noCoverage).allowed, `${resource}:${action}`).toBe(false);
      expect(can(as(DEV), action, resource, noToday).allowed, `${resource}:${action}`).toBe(false);
    }
  });

  it('leaves the clinician away with every cell they had', () => {
    for (const [resource, action] of [...GAINED, ['process_note', 'read'], ['alert', 'read']] as [Resource, Action][]) {
      expect(can(as(NOUR), action, resource, onDay('2026-10-14')).allowed, `${resource}:${action}`).toBe(true);
    }
  });

  it('names the leave in the decision only when coverage made the difference', () => {
    const during = onDay('2026-10-14');
    expect(can(as(DEV), 'read', 'client', during).coveringLeaveId).toBe('lv-nour');
    expect(can(as(NOUR), 'read', 'client', during).coveringLeaveId).toBeUndefined();
    expect(can(as(SAM, 'supervisor'), 'read', 'client', during).coveringLeaveId).toBeUndefined();
    expect(can(as(DEV), 'read', 'client', onDay('2026-11-28')).coveringLeaveId).toBeUndefined();
    // Sam covering a supervisee's client was already a reader; the leave is not their reason.
    const samCovers = onDay('2026-10-14', { ...LEAVE, coveringClinicianId: SAM });
    expect(can(as(SAM, 'supervisor'), 'read', 'client', samCovers)).toMatchObject({ allowed: true });
    expect(can(as(SAM, 'supervisor'), 'read', 'client', samCovers).coveringLeaveId).toBeUndefined();
  });
});

describe('supervision coverage is a second supervisor for a dated window (leave P1-3, D-21)', () => {
  const ROSA = 'u-rosa'; // supervisor, away
  const DEV = 'u-dev'; // supervisor, covering Rosa's supervision
  const PRIYA = 'u-priya'; // associate, Rosa's supervisee
  const LEAVE: NonNullable<Target['coverage']> = {
    leaveId: 'lv-rosa', coveringClinicianId: DEV, fromDate: '2026-10-05', toDate: '2026-11-27',
  };
  /** A client Priya treats, a note Priya wrote about them, both supervised by Rosa — on `today`. */
  const onDay = (today: string, cover: Target['coverage'] = LEAVE): Target => ({
    authorId: PRIYA, authorSupervisorId: ROSA, clinicianId: PRIYA, treatingSupervisorId: ROSA,
    recipientId: PRIYA, authorSupervisorCoverage: cover, treatingSupervisorCoverage: cover, today,
  });
  const as = (id: string, role: Role = 'supervisor'): Actor => ({ id, role });

  // D-21: co-signing, and the three reads a co-signature must not be given without.
  const GAINED: [Resource, Action][] = [
    ['client', 'read'], ['form_submission', 'read'], ['progress_note', 'read'], ['progress_note', 'cosign'],
  ];
  const UNMOVED: [Resource, Action][] = [
    ['client', 'update'], ['fee', 'read'], ['attendance_history', 'read'],
    ['portal_link', 'read'], ['portal_link', 'create'], ['alert', 'read'], ['alert', 'update'],
    ['progress_note', 'create'], ['progress_note', 'update'], ['progress_note', 'sign'],
    ['process_note', 'read'], ['process_note', 'create'], ['process_note', 'update'],
  ];

  it.each(GAINED)('the covering supervisor gains %s / %s on the first day and on the last', (resource, action) => {
    expect(can(as(DEV), action, resource, onDay('2026-10-05')).allowed).toBe(true);
    expect(can(as(DEV), action, resource, onDay('2026-11-27')).allowed).toBe(true);
  });

  it.each(GAINED)('and holds no %s / %s the day before, the day after, once cancelled, or after an early return', (resource, action) => {
    const dev = as(DEV);
    expect(can(dev, action, resource, onDay('2026-10-04')).allowed, 'day before').toBe(false);
    expect(can(dev, action, resource, onDay('2026-11-28')).allowed, 'day after').toBe(false);
    const cancelled = { ...LEAVE, cancelledAt: new Date('2026-09-20T15:00:00Z') };
    expect(can(dev, action, resource, onDay('2026-10-14', cancelled)).allowed, 'cancelled').toBe(false);
    const cameBack = { ...LEAVE, toDate: '2026-10-20' };
    expect(can(dev, action, resource, onDay('2026-10-20', cameBack)).allowed, 'return day').toBe(true);
    expect(can(dev, action, resource, onDay('2026-10-21', cameBack)).allowed, 'after return').toBe(false);
  });

  it.each(UNMOVED)('never gains %s / %s, on any day of the leave', (resource, action) => {
    for (const day of ['2026-10-05', '2026-10-14', '2026-11-27']) {
      expect(can(as(DEV), action, resource, onDay(day)).allowed, day).toBe(false);
    }
  });

  it('covers supervision only from the supervisor role, even with the row in hand', () => {
    for (const role of ['therapist', 'associate'] as Role[]) {
      for (const [resource, action] of GAINED) {
        expect(can(as(DEV, role), action, resource, onDay('2026-10-14')).allowed, `${role} ${resource}:${action}`).toBe(false);
      }
    }
  });

  it('reads notes through the author\'s supervisor and the record through the treating clinician\'s', () => {
    const noteOnly: Target = { ...onDay('2026-10-14'), treatingSupervisorCoverage: undefined };
    expect(can(as(DEV), 'read', 'progress_note', noteOnly).allowed).toBe(true);
    expect(can(as(DEV), 'cosign', 'progress_note', noteOnly).allowed).toBe(true);
    expect(can(as(DEV), 'read', 'client', noteOnly).allowed).toBe(false);
    const recordOnly: Target = { ...onDay('2026-10-14'), authorSupervisorCoverage: undefined };
    expect(can(as(DEV), 'read', 'client', recordOnly).allowed).toBe(true);
    expect(can(as(DEV), 'read', 'form_submission', recordOnly).allowed).toBe(true);
    expect(can(as(DEV), 'read', 'progress_note', recordOnly).allowed).toBe(false);
    expect(can(as(DEV), 'cosign', 'progress_note', recordOnly).allowed).toBe(false);
  });

  it('does not co-sign a note the covering supervisor wrote', () => {
    expect(can(as(DEV), 'cosign', 'progress_note', { ...onDay('2026-10-14'), authorId: DEV }).allowed).toBe(false);
  });

  it('fails closed: a target built without supervision coverage, or without today, denies the covering supervisor', () => {
    const { authorSupervisorCoverage: _a, treatingSupervisorCoverage: _t, ...noCoverage } = onDay('2026-10-14');
    const { today: _d, ...noToday } = onDay('2026-10-14');
    for (const [resource, action] of GAINED) {
      expect(can(as(DEV), action, resource, noCoverage).allowed, `${resource}:${action}`).toBe(false);
      expect(can(as(DEV), action, resource, noToday).allowed, `${resource}:${action}`).toBe(false);
    }
  });

  it('leaves the supervisor away with every cell they had', () => {
    for (const [resource, action] of GAINED) {
      expect(can(as(ROSA), action, resource, onDay('2026-10-14')).allowed, `${resource}:${action}`).toBe(true);
    }
  });

  it('changes nothing for a role outside the clinical row, break-glass included', () => {
    const bare: Target = { ...onDay('2026-10-14'), authorSupervisorCoverage: undefined, treatingSupervisorCoverage: undefined };
    for (const role of ['front_desk', 'admin', 'auditor', 'client', 'public'] as Role[]) {
      for (const breakGlass of [undefined, { reason: 'client in crisis' }]) {
        const named: Actor = { id: DEV, role, breakGlass };
        for (const resource of RESOURCES) {
          for (const action of ACTIONS) {
            expect(can(named, action, resource, onDay('2026-10-14')).allowed, `${role}:${resource}:${action}`)
              .toBe(can(named, action, resource, bare).allowed);
          }
        }
      }
    }
  });

  it('never reaches a process note, the supervisee\'s or anybody\'s', () => {
    for (const day of ['2026-10-05', '2026-10-14', '2026-11-27']) {
      expect(can(as(DEV), 'read', 'process_note', onDay(day)).allowed, day).toBe(false);
      expect(can({ id: DEV, role: 'admin', breakGlass: { reason: 'probe' } }, 'read', 'process_note', onDay(day)).allowed).toBe(false);
    }
  });

  it('names the leave in the decision only when supervision coverage made the difference', () => {
    const during = onDay('2026-10-14');
    expect(can(as(DEV), 'cosign', 'progress_note', during)).toMatchObject({ allowed: true, rule: 'supervisorOfAuthorOrCovering', coveringLeaveId: 'lv-rosa' });
    expect(can(as(DEV), 'read', 'client', during).coveringLeaveId).toBe('lv-rosa');
    expect(can(as(ROSA), 'cosign', 'progress_note', during).coveringLeaveId).toBeUndefined();
    expect(can(as(ROSA), 'read', 'client', during).coveringLeaveId).toBeUndefined();
    expect(can(as(DEV), 'read', 'client', onDay('2026-11-28')).coveringLeaveId).toBeUndefined();
  });
});

describe('process notes do not move during a leave (leave P0-4, D-05)', () => {
  const NOUR = 'u-nour';
  const DEV = 'u-dev';
  const SAM = 'u-sam';
  const DEVS_SUPERVISOR = 'u-devs-supervisor';
  const coverage = { leaveId: 'lv-nour', coveringClinicianId: DEV, fromDate: '2026-10-05', toDate: '2026-11-27' };
  const client = { clinicianId: NOUR, treatingSupervisorId: SAM, coverage };

  it('refuses the clinician away’s notes to every reader but them, on every day of the leave', () => {
    const refused: Actor[] = [
      { id: DEV, role: 'therapist' },
      { id: DEV, role: 'supervisor' },
      { id: SAM, role: 'supervisor' },
      { id: 'u-ray', role: 'admin' },
      { id: 'u-ray', role: 'admin', breakGlass: { reason: 'client in crisis' } },
    ];
    for (const today of ['2026-10-05', '2026-10-14', '2026-11-27']) {
      const note: Target = { ...client, authorId: NOUR, authorSupervisorId: SAM, today };
      for (const actor of refused) {
        expect(can(actor, 'read', 'process_note', note).allowed, `${actor.id}/${actor.role} ${today}`).toBe(false);
        expect(can(actor, 'update', 'process_note', note).allowed, `${actor.id}/${actor.role} ${today}`).toBe(false);
      }
      expect(can({ id: NOUR, role: 'therapist' }, 'read', 'process_note', note).allowed).toBe(true);
    }
  });

  it('keeps the coverer’s own note theirs alone, during the leave and after it', () => {
    for (const today of ['2026-10-14', '2026-11-30']) {
      const note: Target = { ...client, authorId: DEV, authorSupervisorId: DEVS_SUPERVISOR, today };
      expect(can({ id: DEV, role: 'therapist' }, 'read', 'process_note', note).allowed, today).toBe(true);
      for (const actor of [
        { id: NOUR, role: 'therapist' },
        { id: SAM, role: 'supervisor' },
        { id: DEVS_SUPERVISOR, role: 'supervisor' },
      ] as Actor[]) {
        expect(can(actor, 'read', 'process_note', note).allowed, `${actor.id} ${today}`).toBe(false);
      }
    }
  });

  it('lets the coverer start one inside the window and not outside it', () => {
    const dev: Actor = { id: DEV, role: 'therapist' };
    expect(can(dev, 'create', 'process_note', { ...client, today: '2026-10-14' }).allowed).toBe(true);
    expect(can(dev, 'create', 'process_note', { ...client, today: '2026-11-28' }).allowed).toBe(false);
  });
});

describe('break-glass requires a real reason', () => {
  it.each(['', '   '])('rejects reason %j', (reason) => {
    expect(can({ id: ME, role: 'admin', breakGlass: { reason } }, 'read', 'client', {}).allowed).toBe(false);
  });

  it('an admin without break-glass cannot read demographics', () => {
    expect(can({ id: ME, role: 'admin' }, 'read', 'client', {}).allowed).toBe(false);
  });
});

describe('front desk sees no clinical content', () => {
  it.each(['progress_note', 'process_note', 'form_submission', 'attendance_history'] as Resource[])(
    'denied %s',
    (resource) => {
      const [actor, target] = insider('front_desk');
      for (const action of ACTIONS) {
        expect(can(actor, action, resource, target).allowed).toBe(false);
      }
    },
  );
});

describe('auditor', () => {
  it('reads the audit log', () => {
    expect(can({ id: ME, role: 'auditor' }, 'read', 'audit_log').allowed).toBe(true);
  });

  it('cannot reach a client record', () => {
    const [actor, target] = insider('auditor');
    for (const resource of RESOURCES.filter((r) => r !== 'audit_log')) {
      for (const action of ACTIONS) {
        expect(can(actor, action, resource, target).allowed).toBe(false);
      }
    }
  });

  it('is the only role that reads it', () => {
    for (const role of ROLES.filter((r) => r !== 'auditor')) {
      const [actor, target] = insider(role);
      expect(can(actor, 'read', 'audit_log', target).allowed).toBe(false);
    }
  });
});

it('no ad-hoc role checks outside the auth module', () => {
  const offenders: string[] = [];
  // `app/` is where the rule is easiest to break: a page that draws its own
  // conclusion about a role is an endpoint doing its own authorization.
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/auth/') || path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      const src = readFileSync(path, 'utf8');
      // Authorization decisions come from can(); nothing else branches on a role.
      if (/\.role\s*[=!]==|['"](front_desk|therapist|associate|supervisor|admin|auditor|public)['"]\s*[=!]==/.test(src)) {
        offenders.push(path);
      }
    }
  }
  expect(offenders).toEqual([]);
});

describe('caseload scoping', () => {
  it('narrows clinical roles to their own clients', () => {
    for (const role of ['therapist', 'associate', 'supervisor'] as Role[]) {
      expect(ownCaseloadOnly({ id: ME, role })).toBe(true);
    }
  });

  it('does not narrow the roles that work across the practice', () => {
    for (const role of ['front_desk', 'admin', 'auditor', 'client', 'public'] as Role[]) {
      expect(ownCaseloadOnly({ id: ME, role })).toBe(false);
    }
  });
});

describe('the client role reaches exactly one cell, and only their own row', () => {
  const holder = { id: ME, role: 'client' as Role };

  it('confirms and declines their own appointment', () => {
    expect(can(holder, 'update', 'appointment', { ownerClientId: ME }).allowed).toBe(true);
  });

  it('cannot touch an appointment that is not theirs', () => {
    expect(can(holder, 'update', 'appointment', { ownerClientId: OTHER }).allowed).toBe(false);
    // The door answers NotFound before it ever asks, but the matrix has to be
    // the second no as well — a forwarded link is exactly this case.
    expect(can(holder, 'update', 'appointment', {}).allowed).toBe(false);
  });

  it('cannot be talked into it by a relationship or by break-glass', () => {
    const dressed = { id: ME, role: 'client' as Role, breakGlass: { reason: 'x' } };
    const everything: Target = {
      authorId: ME, authorSupervisorId: ME, clinicianId: ME, recipientId: ME,
      treatingSupervisorId: ME,
    };
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        if (resource === 'appointment' && action === 'update') continue;
        expect(can(dressed, action, resource, { ...everything, ownerClientId: ME }).allowed,
          `${resource}:${action}`).toBe(false);
      }
    }
  });

  it('gives a staff role nothing extra from a row being somebody\'s', () => {
    // `ownerClientId` is set on every appointment write, so it must decide
    // nothing for the roles that already have a rule.
    expect(can({ id: ME, role: 'auditor' }, 'update', 'appointment', { ownerClientId: ME }).allowed)
      .toBe(false);
  });
});

describe('the referral directory is written by staff and never by the internet', () => {
  it('the public form may leave an enquiry and may not touch the contact list', () => {
    const stranger: Actor = { id: 'anon', role: 'public' };
    // The one thing it holds, unchanged.
    expect(can(stranger, 'create', 'inquiry').allowed).toBe(true);
    // And nothing at all here. This is the cell that keeps "my GP sent me" a
    // bare code on a public submission: a `create` here would let anybody
    // append a string to a directory the whole practice reads and the report
    // aggregates by.
    for (const action of ACTIONS) {
      expect(can(stranger, action, 'referrer').allowed, action).toBe(false);
    }
  });

  it('a clinician may name a surgery and may not curate the list', () => {
    for (const role of ['therapist', 'associate', 'supervisor'] as Role[]) {
      const c: Actor = { id: ME, role };
      expect(can(c, 'read', 'referrer').allowed, role).toBe(true);
      expect(can(c, 'create', 'referrer').allowed, role).toBe(true);
      // The same line `inquiry` draws: recording is clerical, curating is
      // operations. Retiring a surgery changes what every future call sees.
      expect(can(c, 'update', 'referrer').allowed, role).toBe(false);
    }
  });

  it('front desk and the practice manager curate it, with no break-glass anywhere', () => {
    for (const role of ['front_desk', 'admin'] as Role[]) {
      for (const action of ['read', 'create', 'update'] as const) {
        expect(can({ id: ME, role }, action, 'referrer').allowed, `${role}/${action}`).toBe(true);
        expect(can({ id: ME, role }, action, 'referrer').rule, `${role}/${action}`).toBe('always');
      }
    }
  });

  it('holds no discard: a contact is retired by an update, never destroyed', () => {
    // `active: false` is an `update`. There is deliberately no verb here that
    // removes a row an enquiry and a past report both point at.
    for (const role of ROLES) {
      expect(can({ id: ME, role }, 'discard', 'referrer').allowed, role).toBe(false);
    }
  });

  it('is not reachable by the auditor or a client link', () => {
    for (const role of ['auditor', 'client'] as Role[]) {
      for (const action of ACTIONS) {
        expect(can({ id: ME, role }, action, 'referrer', { ownerClientId: ME }).allowed,
          `${role}/${action}`).toBe(false);
      }
    }
  });
});

describe('capacity is declared by the clinician it is about, and by nobody else', () => {
  const alex: Actor = { id: ME, role: 'therapist' };
  const own: Target = { subjectUserId: ME };
  const somebodyElse: Target = { subjectUserId: OTHER };

  it('a clinician sets their own', () => {
    expect(can(alex, 'update', 'capacity', own).allowed).toBe(true);
    expect(can(alex, 'update', 'capacity', own).rule).toBe('self');
  });

  it('and cannot set a colleague\'s, at any seniority', () => {
    for (const role of ['therapist', 'associate', 'supervisor'] as Role[]) {
      expect(can({ id: ME, role }, 'update', 'capacity', somebodyElse).allowed, role).toBe(false);
    }
  });

  it('a supervisor cannot set it for a supervisee they otherwise oversee', () => {
    expect(can({ id: ME, role: 'supervisor' }, 'update', 'capacity', {
      subjectUserId: OTHER, authorSupervisorId: ME, treatingSupervisorId: ME, clinicianId: OTHER,
    }).allowed).toBe(false);
  });

  it('the practice manager reads every row and writes none — break-glass included', () => {
    const ray: Actor = { id: ME, role: 'admin' };
    expect(can(ray, 'read', 'capacity', somebodyElse).allowed).toBe(true);
    expect(can(ray, 'update', 'capacity', somebodyElse).allowed).toBe(false);
    expect(can(ray, 'update', 'capacity', own).allowed).toBe(false);
    expect(can({ ...ray, breakGlass: { reason: 'short staffed' } }, 'update', 'capacity', somebodyElse).allowed).toBe(false);
  });

  it('front desk reads it to decide where a call goes, and never writes it', () => {
    const dana: Actor = { id: ME, role: 'front_desk' };
    expect(can(dana, 'read', 'capacity', somebodyElse).allowed).toBe(true);
    expect(can(dana, 'update', 'capacity', own).allowed).toBe(false);
  });

  it('is unreachable without a subject — a missing target is never a match', () => {
    expect(can(alex, 'update', 'capacity', {}).allowed).toBe(false);
  });

  it('is not reachable by the auditor, the client link, or the public form', () => {
    for (const role of ['auditor', 'client', 'public'] as Role[]) {
      for (const action of ACTIONS) {
        expect(can({ id: ME, role }, action, 'capacity', own).allowed, `${role}/${action}`).toBe(false);
      }
    }
  });
});

describe('the public role is one cell wide', () => {
  const stranger_ = { id: 'public', role: 'public' as Role };

  it('writes an enquiry', () => {
    expect(can(stranger_, 'create', 'inquiry').allowed).toBe(true);
  });

  it('cannot read back the one thing it can write', () => {
    // The refusal that keeps the form from becoming a lookup: a submitter must
    // not be able to learn that the practice already holds this person.
    expect(can(stranger_, 'read', 'inquiry').allowed).toBe(false);
    expect(can(stranger_, 'update', 'inquiry').allowed).toBe(false);
    expect(can(stranger_, 'discard', 'inquiry').allowed).toBe(false);
  });

  it('reaches nothing else, under any relationship or break-glass claim', () => {
    const dressed = { id: ME, role: 'public' as Role, breakGlass: { reason: 'x' } };
    const everything: Target = {
      authorId: ME, authorSupervisorId: ME, clinicianId: ME, recipientId: ME,
      treatingSupervisorId: ME, ownerClientId: ME,
    };
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        if (resource === 'inquiry' && action === 'create') continue;
        expect(can(dressed, action, resource, everything).allowed, `${resource}:${action}`).toBe(false);
      }
    }
  });

  it('is decided by `unconditional`, never by `always`', () => {
    // `always` reads as "any actor in this role" and every other role holding
    // it was hired. Keeping the anonymous cell on its own rule name is what
    // makes an accidental copy of it visible in the audit trail.
    expect(can(stranger_, 'create', 'inquiry').rule).toBe('unconditional');
  });

  it('is spellable in the audit log, and by nothing that logs in', () => {
    // It is in the database enum for the same reason `client` is: an enquiry
    // that arrived through the website has to be attributable to what made it,
    // not to whichever staff account was nearest.
    expect(Object.keys(PrismaRole)).toContain('public');
    // And there is no account holding it — the seed creates none, and the
    // session module reads a `User` row, which is the only way an actor with a
    // role other than `public` is ever built.
    expect(ROLES).toContain('public');
  });
});

describe("a supervisor's reach over a supervisee's caseload", () => {
  const superviseesClient = { clinicianId: OTHER, treatingSupervisorId: ME };
  const boss = { id: ME, role: 'supervisor' as Role };

  it.each(['client', 'fee', 'attendance_history', 'form_submission'] as Resource[])(
    'reaches %s',
    (resource) => {
      expect(can(boss, 'read', resource, superviseesClient).allowed).toBe(true);
    },
  );

  it('stops at the process note — the one exception, and the point', () => {
    expect(can(boss, 'read', 'process_note', { ...superviseesClient, authorId: OTHER }).allowed).toBe(false);
  });

  it('does not write into a supervisee’s record', () => {
    expect(can(boss, 'create', 'progress_note', superviseesClient).allowed).toBe(false);
    expect(can(boss, 'create', 'process_note', superviseesClient).allowed).toBe(false);
  });

  it('does not reach a clinician they do not supervise', () => {
    const notMine = { clinicianId: OTHER, treatingSupervisorId: 'u-third' };
    for (const resource of ['client', 'fee', 'attendance_history', 'form_submission'] as Resource[]) {
      expect(can(boss, 'read', resource, notMine).allowed, resource).toBe(false);
    }
  });

  it('is not available to a therapist who happens to be named as supervisor', () => {
    // The rule checks the role as well as the relationship, so a data error
    // that points a client at a non-supervisor grants nothing.
    expect(can({ id: ME, role: 'therapist' }, 'read', 'client', superviseesClient).allowed).toBe(false);
  });
});

describe('the second-factor seam', () => {
  it('covers every role a stolen session would reach a record through', () => {
    for (const role of ['therapist', 'associate', 'supervisor'] as Role[]) {
      expect(requiresSecondFactor(role), role).toBe(true);
    }
    // Not a clinical title, but the most valuable credential in the building:
    // break-glass is one typed reason away from a record, and the audit log
    // would record it faithfully as them.
    expect(requiresSecondFactor('admin')).toBe(true);
  });

  it('leaves the roles that never reach clinical content alone', () => {
    expect(requiresSecondFactor('front_desk')).toBe(false);
    expect(requiresSecondFactor('auditor')).toBe(false);
    expect(requiresSecondFactor('client')).toBe(false);
    expect(requiresSecondFactor('public')).toBe(false);
  });

  it('decides it from the role alone, so an identity provider reads it rather than restating it', () => {
    for (const role of ROLES) {
      expect(typeof requiresSecondFactor(role)).toBe('boolean');
    }
  });
});

describe('the inquiry stage', () => {
  it('lets front desk and the practice manager declare a call dead', () => {
    for (const role of ['front_desk', 'admin'] as Role[]) {
      expect(can({ id: ME, role }, 'discard', 'inquiry').allowed, role).toBe(true);
    }
  });

  it('denies discard to everybody else, relationship or not', () => {
    for (const role of ['therapist', 'associate', 'supervisor', 'auditor', 'client', 'public'] as Role[]) {
      const [actor, target] = insider(role);
      expect(can(actor, 'discard', 'inquiry', target).allowed, role).toBe(false);
    }
  });

  it('lets a clinician write down a call they took themselves', () => {
    const [actor, target] = stranger('therapist');
    expect(can(actor, 'read', 'inquiry', target).allowed).toBe(true);
    expect(can(actor, 'create', 'inquiry', target).allowed).toBe(true);
    // Editing somebody else's record of a call is front desk's job, not theirs.
    expect(can(actor, 'update', 'inquiry', target).allowed).toBe(false);
  });

  it('offers break-glass nothing, because there is nothing clinical to reach', () => {
    // Every admin cell here is `always`, so break-glass must not be what decides
    // any of them — otherwise the row would imply an inquiry holds clinical data.
    for (const action of ACTIONS) {
      const d = can({ id: ME, role: 'admin' }, action, 'inquiry');
      expect(d.rule, action).not.toBe('breakGlass');
    }
  });

  it('is the only resource `discard` reaches', () => {
    for (const role of ROLES) {
      const [actor, target] = insider(role);
      for (const resource of RESOURCES.filter((r) => r !== 'inquiry')) {
        expect(can(actor, 'discard', resource, target).allowed, `${role}/${resource}`).toBe(false);
      }
    }
  });
});
