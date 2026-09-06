/**
 * The ONLY authorization surface in Clearpath. No endpoint, query, or view may
 * perform an ad-hoc role check — see permissions.test.ts ("no ad-hoc role checks").
 *
 * The defining rule of this domain: a `process_note` is readable by its author
 * and by nobody else, ever. Not a supervisor, not an admin, not break-glass.
 */

import { isBreakGlassReason, type BreakGlass } from './break-glass';

export type Role =
  | 'front_desk'
  | 'therapist'
  | 'associate'
  | 'supervisor'
  | 'admin'
  | 'auditor'
  | 'client';

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
  | 'alert' // private risk notifications, addressed to one clinician
  | 'portal_link' // a client's own tokenized door into their schedule
  | 'audit_log'
  | 'user'; // accounts, roles, supervision relationships

export type Action = 'read' | 'create' | 'update' | 'sign' | 'cosign';

export const ROLES: readonly Role[] = [
  'front_desk', 'therapist', 'associate', 'supervisor', 'admin', 'auditor', 'client',
];
export const RESOURCES: readonly Resource[] = [
  'client', 'fee', 'appointment', 'attendance_history', 'progress_note',
  'process_note', 'form_template', 'form_request', 'form_submission',
  'alert', 'portal_link', 'audit_log', 'user',
];
export const ACTIONS: readonly Action[] = ['read', 'create', 'update', 'sign', 'cosign'];

export interface Actor {
  id: string;
  role: Role;
  /**
   * Set only for an explicit, reason-carrying break-glass session. The reason
   * is a code from a closed set rather than a sentence: it is copied onto every
   * audit row the session writes, and that table is append-only and read by the
   * one role that may never read a note. See `break-glass.ts`.
   */
  breakGlass?: BreakGlass;
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
  /** The single person a private notification is addressed to. */
  recipientId?: string;
  /** Supervisor of the treating clinician, at read time. */
  treatingSupervisorId?: string;
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
  /**
   * The treating clinician, or the supervisor responsible for their practice.
   *
   * Supervision is clinical responsibility, not just a signature: a supervisor
   * who can countersign a note but cannot open the record it belongs to has to
   * countersign blind. So their reach over a supervisee's caseload matches the
   * supervisee's — with exactly one exception, `process_note`, which stays
   * `author` and is the sharper for it. The supervisor sees everything about
   * this client except the one thing.
   */
  treatingOrSupervising: (a: Actor, t: Target) =>
    (t.clinicianId !== undefined && a.id === t.clinicianId) ||
    (a.role === 'supervisor' && t.treatingSupervisorId !== undefined && a.id === t.treatingSupervisorId),
  /** Addressed to exactly one person. Never a shared inbox, never front desk. */
  recipient: (a: Actor, t: Target) =>
    t.recipientId !== undefined && a.id === t.recipientId,
  /**
   * Admin emergency access. Reaches demographics and progress notes only.
   *
   * The code is re-checked here rather than trusted from the caller. The
   * boundary that builds an `Actor` already validates it, and this is the rule
   * that opens the clinical tier: it should not open on a value it has not
   * looked at.
   */
  breakGlass: (a: Actor) => !!a.breakGlass && isBreakGlassReason(a.breakGlass.reason),
} satisfies Record<string, (a: Actor, t: Target) => boolean>;

type Cell = Partial<Record<Action, RuleName>>;
type RoleMatrix = Partial<Record<Resource, Cell>>;

/** Shared by therapist, associate and supervisor. Anything absent is denied. */
const CLINICIAN: RoleMatrix = {
  client: { read: 'treatingOrSupervising', update: 'treatingOrSupervising' },
  fee: { read: 'treatingOrSupervising' },
  appointment: { read: 'always', create: 'always', update: 'always' },
  attendance_history: { read: 'treatingOrSupervising' },
  progress_note: {
    read: 'authorOrSupervisor',
    // Writing is the treating clinician's alone. A supervisor countersigns the
    // record; they do not author into somebody else's.
    create: 'treating',
    update: 'author',
    sign: 'author',
  },
  process_note: { read: 'author', create: 'treating', update: 'author' },
  form_template: { read: 'always' },
  form_request: { read: 'always', create: 'always' },
  form_submission: { read: 'treatingOrSupervising' },
  alert: { read: 'recipient', update: 'recipient' },
  // Issuing a client their own door is operational, so a clinician may do it
  // for a client they treat. It grants nothing the client does not already
  // know: when they are coming in, and with whom.
  portal_link: { read: 'treatingOrSupervising', create: 'treating' },
};

/**
 * role × resource × action. Absent entry = deny. This file is the whole policy.
 */
const MATRIX: Record<Role, RoleMatrix> = {
  front_desk: {
    // Runs the calendar. Never sees clinical content of any kind.
    client: { read: 'always', create: 'always', update: 'always' },
    fee: { read: 'always' },
    appointment: { read: 'always', create: 'always', update: 'always' },
    form_request: { read: 'always', create: 'always' },
    portal_link: { read: 'always', create: 'always' },
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
    portal_link: { read: 'always', create: 'always' },
    user: { read: 'always', create: 'always', update: 'always' },
  },

  auditor: {
    // Read-only on the audit trail; no path to a client record.
    audit_log: { read: 'always' },
  },

  /**
   * Empty on purpose. Clients never authenticate into the staff application;
   * they reach exactly one form through a tokenized link, and that door is
   * guarded by the token rather than by this matrix. The role exists so a
   * submission has an honest actor in the audit trail.
   */
  client: {},
};

/**
 * Roles whose caseload is their own clients.
 *
 * This is data scoping rather than a permission — the matrix already says a
 * clinician may only *read* a client they treat — but it is still a decision
 * made from a role, so it lives here beside the matrix rather than as an
 * `actor.role === 'therapist'` in a query builder. That is the whole point of
 * the one-module rule: role logic is reviewable in one file or it is nowhere.
 */
export function ownCaseloadOnly(actor: Actor): boolean {
  return actor.role === 'therapist' || actor.role === 'associate' || actor.role === 'supervisor';
}

/** A supervisor's caseload includes the clients their supervisees carry. */
export function includesSuperviseeCaseloads(actor: Actor): boolean {
  return actor.role === 'supervisor';
}

/**
 * Whether this author's progress notes need a supervisor's signature.
 *
 * Pre-licensed associates practise under supervision, so their notes are not a
 * complete record until countersigned. Modelling that as a *permission* was the
 * intuitive wrong answer — an associate writes and signs exactly what a
 * therapist does; the difference is a workflow gate on the record's completion,
 * which is why associate and therapist share an identical matrix row.
 */
export function requiresCoSignature(authorRole: Role): boolean {
  return authorRole === 'associate';
}

/**
 * Roles a second factor would be required for, if this project had auth.
 *
 * It does not, on purpose — authentication is its own project, and a
 * half-built version of it here would make the authorization work harder to
 * read rather than easier. What lives here is the *policy*, because deciding
 * which roles need a second factor is a role-derived rule and this file is
 * where every role-derived rule lives. When a real identity provider is
 * attached, it reads this; it does not re-decide it.
 *
 * The line is drawn by capability, not by job title. Front desk runs the
 * calendar and never reaches clinical content, so their account is worth
 * little to an attacker beyond a list of names and times. The three clinical
 * roles reach notes. The practice manager reaches them too, through
 * break-glass, which makes theirs the single most valuable credential in the
 * building — a stolen admin session is one typed reason away from a client's
 * record, and the audit log would faithfully record that "they" opened it.
 */
export function requiresSecondFactor(role: Role): boolean {
  return role === 'therapist' || role === 'associate' || role === 'supervisor' || role === 'admin';
}

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
