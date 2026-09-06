import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
    reminder_cadence: 'update',
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
    reminder_cadence: 'update',
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
    reminder_cadence: 'update',
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
    reminder_cadence: 'update',
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
  }),
  auditor: spec({ audit_log: 'read' }),
  // The tokenized door, and nothing else in the matrix. `update` is confirm and
  // decline; reading behind the link and asking for a different time change
  // nothing and stay outside this file.
  client: spec({ appointment: 'update', reminder_cadence: 'update' }),
};

/** Cells allowed with NO relationship and NO break-glass. */
const UNCONDITIONAL: Record<Role, Set<string>> = {
  front_desk: ALLOWED.front_desk,
  therapist: spec({
    appointment: 'read create update',
    form_template: 'read',
    form_request: 'read create',
  }),
  associate: spec({
    appointment: 'read create update',
    form_template: 'read',
    form_request: 'read create',
  }),
  supervisor: spec({
    appointment: 'read create update',
    form_template: 'read',
    form_request: 'read create',
  }),
  admin: spec({
    fee: 'read update waive',
    appointment: 'read create update',
    attendance_history: 'read',
    form_template: 'read create update',
    form_request: 'read',
    portal_link: 'read create',
    user: 'read create update',
  }),
  auditor: ALLOWED.auditor,
  // Never unconditional: without a row that is theirs, a token decides `never`.
  client: new Set<string>(),
};

const ME = 'u-me';
const OTHER = 'u-other';

/** Actor holds every relationship to the target it possibly could. */
const insider = (role: Role): [Actor, Target] => [
  { id: ME, role, breakGlass: { reason: 'client in crisis' } },
  {
    authorId: ME, authorSupervisorId: ME, clinicianId: ME, recipientId: ME,
    treatingSupervisorId: ME, ownerClientId: ME,
  },
];
/** Actor supervises the target's author but wrote nothing. */
const oversight = (role: Role): [Actor, Target] => [
  { id: ME, role },
  {
    authorId: OTHER, authorSupervisorId: ME, clinicianId: OTHER, recipientId: OTHER,
    treatingSupervisorId: ME, ownerClientId: OTHER,
  },
];
/** Actor holds no relationship at all. */
const stranger = (role: Role): [Actor, Target] => [
  { id: ME, role },
  {
    authorId: OTHER, authorSupervisorId: OTHER, clinicianId: OTHER, recipientId: OTHER,
    treatingSupervisorId: OTHER, ownerClientId: OTHER,
  },
];

describe('permission matrix — every cell', () => {
  const cells: [Role, Resource, Action][] = ROLES.flatMap((role) =>
    RESOURCES.flatMap((res) => ACTIONS.map((a) => [role, res, a] as [Role, Resource, Action])),
  );

  it('covers 588 cells', () => expect(cells).toHaveLength(ROLES.length * RESOURCES.length * ACTIONS.length));

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
      if (/\.role\s*[=!]==|['"](front_desk|therapist|associate|supervisor|admin|auditor)['"]\s*[=!]==/.test(src)) {
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
    for (const role of ['front_desk', 'admin', 'auditor', 'client'] as Role[]) {
      expect(ownCaseloadOnly({ id: ME, role })).toBe(false);
    }
  });
});

/**
 * P0-7. The waiver is a matrix cell, not an `if` in a handler — which is the
 * only reason "who can undo an automatic charge" is answerable by reading one
 * file. The existing comment in `lifecycle.ts` said waiving a fee is a
 * management decision rather than a data-entry one; this is what makes it true.
 */
describe('waiving a fee', () => {
  it('is the practice manager\'s alone', () => {
    expect(can({ id: ME, role: 'admin' }, 'waive', 'fee').allowed).toBe(true);
  });

  it('is denied to every other role, relationship or not', () => {
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      const [actor, target] = insider(role);
      expect(can(actor, 'waive', 'fee', target).allowed, role).toBe(false);
    }
  });

  it('is denied to front desk in particular — they take the call about the charge', () => {
    const [actor, target] = insider('front_desk');
    expect(can(actor, 'waive', 'fee', target).allowed).toBe(false);
  });

  it('exists on the fee resource and nowhere else', () => {
    for (const role of ROLES) {
      const [actor, target] = insider(role);
      for (const resource of RESOURCES.filter((r) => r !== 'fee')) {
        expect(can(actor, 'waive', resource, target).allowed, `${role}/${resource}`).toBe(false);
      }
    }
  });
});

describe('the client role reaches exactly two cells, and only their own row', () => {
  const holder = { id: ME, role: 'client' as Role };

  it('confirms and declines their own appointment', () => {
    expect(can(holder, 'update', 'appointment', { ownerClientId: ME }).allowed).toBe(true);
  });

  it('chooses how many reminders it gets, for their own row', () => {
    expect(can(holder, 'update', 'reminder_cadence', { ownerClientId: ME }).allowed).toBe(true);
    expect(can(holder, 'update', 'reminder_cadence', { ownerClientId: OTHER }).allowed).toBe(false);
    expect(can(holder, 'update', 'reminder_cadence', {}).allowed).toBe(false);
  });

  /**
   * The line the second cell is drawn on. A leaked link that leaves somebody on
   * one reminder instead of three is strictly less harmful than one that
   * cancels their session — which this door already does. A leaked link that
   * reached the *channel* could set `none`, which ends the messages and the fee
   * together, so nothing would notice: no missed charge, no complaint, just a
   * client who stops being reminded.
   */
  it('cannot reach the channel, which is the setting that ends the fee', () => {
    for (const action of ACTIONS) {
      expect(can(holder, action, 'client', { ownerClientId: ME }).allowed, action).toBe(false);
    }
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
        if (action === 'update' && (resource === 'appointment' || resource === 'reminder_cadence')) continue;
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
  });

  it('decides it from the role alone, so an identity provider reads it rather than restating it', () => {
    for (const role of ROLES) {
      expect(typeof requiresSecondFactor(role)).toBe('boolean');
    }
  });
});
