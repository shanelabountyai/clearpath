/**
 * The ONLY authorization surface in Clearpath. No endpoint, query, or view may
 * perform an ad-hoc role check — see permissions.test.ts ("no ad-hoc role checks").
 *
 * The defining rule of this domain: a `process_note` is readable by its author
 * and by nobody else, ever. Not a supervisor, not an admin, not break-glass.
 */

export type Role =
  | 'front_desk'
  | 'therapist'
  | 'associate'
  | 'supervisor'
  | 'admin'
  | 'auditor';

export type Resource =
  | 'client' // demographics, emergency contact, consent status
  | 'fee' // standard / sliding-scale override
  | 'appointment'
  | 'attendance_history' // no-show + late-cancel counts
  | 'progress_note' // the official record
  | 'process_note' // the therapist's private working notes
  | 'form_template'
  | 'form_request' // "sent / submitted ✓" status, no content
  | 'form_submission' // answers + scores; clinical data
  | 'audit_log'
  | 'user'; // accounts, roles, supervision relationships

export type Action = 'read' | 'create' | 'update' | 'sign' | 'cosign';

export const ROLES: readonly Role[] = [
  'front_desk', 'therapist', 'associate', 'supervisor', 'admin', 'auditor',
];
export const RESOURCES: readonly Resource[] = [
  'client', 'fee', 'appointment', 'attendance_history', 'progress_note',
  'process_note', 'form_template', 'form_request', 'form_submission',
  'audit_log', 'user',
];
export const ACTIONS: readonly Action[] = ['read', 'create', 'update', 'sign', 'cosign'];

export interface Actor {
  id: string;
  role: Role;
  /** Set only for an explicit, reason-carrying break-glass session. */
  breakGlass?: { reason: string };
}

/**
 * Relationship facts about the thing being touched, resolved from data by the
 * caller. Supervision is data, not code: change `supervisorId` in the database
 * and access + co-sign routing follow immediately.
 */
export interface Target {
  /** Author of a note. */
  authorId?: string;
  /** Supervisor of the note's author, at read time. */
  authorSupervisorId?: string;
  /** Treating clinician of the client this resource belongs to. */
  clinicianId?: string;
}

type RuleName = keyof typeof RULES;

const isAuthor = (a: Actor, t: Target): boolean =>
  t.authorId !== undefined && a.id === t.authorId;

const supervises = (a: Actor, t: Target): boolean =>
  a.role === 'supervisor' &&
  t.authorSupervisorId !== undefined &&
  a.id === t.authorSupervisorId;

const RULES = {
  never: () => false,
  always: () => true,
  author: isAuthor,
  authorOrSupervisor: (a: Actor, t: Target) => isAuthor(a, t) || supervises(a, t),
  // You do not co-sign your own note.
  supervisorOfAuthor: (a: Actor, t: Target) => supervises(a, t) && !isAuthor(a, t),
  treating: (a: Actor, t: Target) =>
    t.clinicianId !== undefined && a.id === t.clinicianId,
  /** Admin emergency access. Reaches demographics and progress notes only. */
  breakGlass: (a: Actor) => !!a.breakGlass?.reason.trim(),
} satisfies Record<string, (a: Actor, t: Target) => boolean>;

type Cell = Partial<Record<Action, RuleName>>;
type RoleMatrix = Partial<Record<Resource, Cell>>;

/** Shared by therapist, associate and supervisor. Anything absent is denied. */
const CLINICIAN: RoleMatrix = {
  client: { read: 'treating', update: 'treating' },
  fee: { read: 'treating' },
  appointment: { read: 'always', create: 'always', update: 'always' },
  attendance_history: { read: 'treating' },
  progress_note: {
    read: 'authorOrSupervisor',
    create: 'treating',
    update: 'author',
    sign: 'author',
  },
  process_note: { read: 'author', create: 'treating', update: 'author' },
  form_template: { read: 'always' },
  form_request: { read: 'always', create: 'always' },
  form_submission: { read: 'treating' },
};

/**
 * role × resource × action. Absent entry = deny. This file is the whole policy.
 */
export const MATRIX: Record<Role, RoleMatrix> = {
  front_desk: {
    // Runs the calendar. Never sees clinical content of any kind.
    client: { read: 'always', create: 'always', update: 'always' },
    fee: { read: 'always' },
    appointment: { read: 'always', create: 'always', update: 'always' },
    form_request: { read: 'always', create: 'always' },
  },

  therapist: CLINICIAN,
  associate: CLINICIAN, // co-signature is a workflow gate, not a permission

  supervisor: {
    ...CLINICIAN,
    progress_note: { ...CLINICIAN.progress_note, cosign: 'supervisorOfAuthor' },
    // process_note deliberately inherits `read: author` — a supervisor reading a
    // supervisee's process note is a 403, and the denial is audit-logged.
  },

  admin: {
    // Practice manager. Clinical reach only through logged break-glass.
    client: { read: 'breakGlass', update: 'breakGlass' },
    fee: { read: 'always', update: 'always' },
    appointment: { read: 'always', create: 'always', update: 'always' },
    attendance_history: { read: 'always' },
    progress_note: { read: 'breakGlass' },
    // process_note: no entry. Break-glass does not reach it.
    form_template: { read: 'always', create: 'always', update: 'always' },
    form_request: { read: 'always' },
    user: { read: 'always', create: 'always', update: 'always' },
  },

  auditor: {
    // Read-only on the audit trail; no path to a client record.
    audit_log: { read: 'always' },
  },
};

export interface Decision {
  allowed: boolean;
  /** Which matrix rule decided it — goes in the audit row. */
  rule: RuleName;
  /** True whenever the actor is in a break-glass session, allowed or not. */
  breakGlass: boolean;
}

export function can(
  actor: Actor,
  action: Action,
  resource: Resource,
  target: Target = {},
): Decision {
  const rule = MATRIX[actor.role]?.[resource]?.[action] ?? 'never';
  return {
    allowed: RULES[rule](actor, target),
    rule,
    breakGlass: !!actor.breakGlass,
  };
}
