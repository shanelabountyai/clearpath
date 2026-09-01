import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS, RESOURCES, ROLES,
  can, ownCaseloadOnly,
  type Action, type Actor, type Resource, type Role, type Target,
} from './permissions.js';

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
  }),
  admin: spec({
    client: 'read update', // break-glass only
    fee: 'read update',
    appointment: 'read create update',
    attendance_history: 'read',
    progress_note: 'read', // break-glass only
    form_template: 'read create update',
    form_request: 'read',
    user: 'read create update',
  }),
  auditor: spec({ audit_log: 'read' }),
  client: new Set<string>(),
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
    fee: 'read update',
    appointment: 'read create update',
    attendance_history: 'read',
    form_template: 'read create update',
    form_request: 'read',
    user: 'read create update',
  }),
  auditor: ALLOWED.auditor,
  client: ALLOWED.client,
};

const ME = 'u-me';
const OTHER = 'u-other';

/** Actor holds every relationship to the target it possibly could. */
const insider = (role: Role): [Actor, Target] => [
  { id: ME, role, breakGlass: { reason: 'client in crisis' } },
  { authorId: ME, authorSupervisorId: ME, clinicianId: ME, recipientId: ME },
];
/** Actor supervises the target's author but wrote nothing. */
const oversight = (role: Role): [Actor, Target] => [
  { id: ME, role },
  { authorId: OTHER, authorSupervisorId: ME, clinicianId: OTHER, recipientId: OTHER },
];
/** Actor holds no relationship at all. */
const stranger = (role: Role): [Actor, Target] => [
  { id: ME, role },
  { authorId: OTHER, authorSupervisorId: OTHER, clinicianId: OTHER, recipientId: OTHER },
];

describe('permission matrix — every cell', () => {
  const cells: [Role, Resource, Action][] = ROLES.flatMap((role) =>
    RESOURCES.flatMap((res) => ACTIONS.map((a) => [role, res, a] as [Role, Resource, Action])),
  );

  it('covers 420 cells', () => expect(cells).toHaveLength(420));

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
  for (const f of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
    if (!f.endsWith('.ts') || f.startsWith('auth/')) continue;
    const src = readFileSync(`src/${f}`, 'utf8');
    // Authorization decisions come from can(); nothing else branches on a role.
    if (/\.role\s*[=!]==|['"](front_desk|therapist|associate|supervisor|admin|auditor)['"]\s*[=!]==/.test(src)) {
      offenders.push(f);
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

it('the client role can do nothing through the staff matrix', () => {
  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      const [a, t] = [{ id: ME, role: 'client' as Role, breakGlass: { reason: 'x' } },
        { authorId: ME, authorSupervisorId: ME, clinicianId: ME, recipientId: ME }];
      expect(can(a, action, resource, t).allowed, `${resource}:${action}`).toBe(false);
    }
  }
});
