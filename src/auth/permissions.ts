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
  | 'auditor'
  | 'client'
  /**
   * A stranger on the public enquiry form. Never authenticates, is never a
   * `User` row, and holds exactly one cell.
   *
   * It is a role rather than a guard bypass for the reason this whole file
   * exists: "what can an anonymous request do to this database" has to be
   * answerable by reading the matrix. Written as a bypass it would be
   * answerable only by auditing every route.
   */
  | 'public';

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
  | 'user' // accounts, roles, supervision relationships
  | 'inquiry' // a caller, before there is a client record to put them in
  /**
   * A clinician's own statement about whether they can take somebody new.
   *
   * Its own resource rather than an `update` on `user`, for the reason `discard`
   * is not `delete`: `user` update is roles and supervision, and a clinician
   * must never hold that. This is one boolean about oneself, and it reads
   * wrong anywhere else.
   */
  | 'capacity';

/**
 * `waive` is its own action rather than an `update` on `fee`, because reversing
 * money the practice already decided to charge is a different power from
 * setting a sliding-scale rate — and the whole argument of this file is that a
 * power nobody named is a power nobody reviewed.
 *
 * `discard` follows it, and is deliberately not `delete`. It applies to exactly
 * one resource and reads wrong anywhere else — whereas a generic `delete` is a
 * verb a later reviewer would reach for on a table that must never lose a row.
 */
export type Action = 'read' | 'create' | 'update' | 'sign' | 'cosign' | 'waive' | 'discard';

export const ROLES: readonly Role[] = [
  'front_desk', 'therapist', 'associate', 'supervisor', 'admin', 'auditor', 'client', 'public',
];
export const RESOURCES: readonly Resource[] = [
  'client', 'fee', 'appointment', 'attendance_history', 'progress_note',
  'process_note', 'form_template', 'form_request', 'form_submission',
  'alert', 'portal_link', 'audit_log', 'user', 'inquiry', 'capacity',
];
export const ACTIONS: readonly Action[] = [
  'read', 'create', 'update', 'sign', 'cosign', 'waive', 'discard',
];

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
  /** The single person a private notification is addressed to. */
  recipientId?: string;
  /** Supervisor of the treating clinician, at read time. */
  treatingSupervisorId?: string;
  /**
   * The client a row belongs to, resolved from the token that reached it.
   *
   * Only the tokenized door ever sets this: it is how a client's own link
   * becomes an authorization fact this file can decide on, rather than a check
   * living in `portal/service.ts` where nobody reviewing policy would find it.
   */
  ownerClientId?: string;
  /** The staff member a row is *about*, where that is the whole relationship. */
  subjectUserId?: string;
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
  /**
   * True for anybody, deliberately named apart from `always`.
   *
   * `always` means "any actor holding this role", and every role holding it is
   * a person the practice hired. This one means "any actor at all, including
   * one nobody authenticated" — same function, different claim, and the audit
   * row records which of the two decided.
   */
  unconditional: () => true,
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
  /**
   * The actor is the person this row is about.
   *
   * Narrower than `recipient`, which is about delivery: this one says the row
   * has no meaning apart from whose it is. A clinician declaring their own
   * capacity is the only holder, and the practice manager deliberately is not
   * — see the `capacity` cells.
   */
  self: (a: Actor, t: Target) =>
    t.subjectUserId !== undefined && a.id === t.subjectUserId,
  /** Addressed to exactly one person. Never a shared inbox, never front desk. */
  recipient: (a: Actor, t: Target) =>
    t.recipientId !== undefined && a.id === t.recipientId,
  /**
   * A client reaching their own row through their own link.
   *
   * The token is the authentication — exactly as strong as the email it
   * arrived in — and the door resolves whose row it names before asking. What
   * lives here is the *capability*, so "what can a forwarded link do" is
   * answerable from this file: confirm or cancel one appointment belonging to
   * one client, and nothing else in the matrix.
   */
  token: (a: Actor, t: Target) =>
    a.role === 'client' && t.ownerClientId !== undefined && a.id === t.ownerClientId,
  /** Admin emergency access. Reaches demographics and progress notes only. */
  breakGlass: (a: Actor) => !!a.breakGlass?.reason.trim(),
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
  // A clinician who takes their own call should be able to write it down, and
  // an inquiry asking for them by name is a capacity question they answer. No
  // `discard`: recording a call is clerical, declaring one dead is operations.
  inquiry: { read: 'always', create: 'always' },
  // Read every clinician's, set only your own. Whether you can take somebody
  // new is a judgement about your own caseload, and it is not delegable —
  // which is why `update` here is `self` and not `always`.
  capacity: { read: 'always', update: 'self' },
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
    // Owns the phone, so owns the caller who is not yet anybody — including
    // declaring one dead. There is no clinical content here to withhold.
    inquiry: { read: 'always', create: 'always', update: 'always', discard: 'always' },
    // Reads it to decide where a call goes; never sets it. Assignment is front
    // desk's call, capacity is the clinician's answer, and the whole point of
    // the signal is that those are two different people.
    capacity: { read: 'always' },
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
    // Waiving is the practice manager's alone. Front desk runs the calendar and
    // takes the phone call about a fee; deciding not to charge it is the thing
    // they are not allowed to do, and the denial is on the record.
    fee: { read: 'always', update: 'always', waive: 'always' },
    appointment: { read: 'always', create: 'always', update: 'always' },
    attendance_history: { read: 'always' },
    progress_note: { read: 'breakGlass' },
    // process_note: no entry. Break-glass does not reach it.
    form_template: { read: 'always', create: 'always', update: 'always' },
    form_request: { read: 'always' },
    portal_link: { read: 'always', create: 'always' },
    user: { read: 'always', create: 'always', update: 'always' },
    // Unconditional, and no break-glass entry anywhere in this row: an inquiry
    // holds no clinical content, so there is nothing here to break glass for.
    inquiry: { read: 'always', create: 'always', update: 'always', discard: 'always' },
    // Read, and deliberately no `update` — the one cell the practice manager
    // is denied that has nothing clinical in it, and no break-glass to reach
    // it with. A manager who can mark a clinician open has made the signal
    // mean "what the practice wants" rather than "what the clinician can do",
    // and the row it would overwrite is the only defence against a caseload
    // nobody agreed to. Deactivating a departing clinician is `user.update`,
    // which admin does hold; declaring someone has room is not the same act.
    capacity: { read: 'always' },
  },

  auditor: {
    // Read-only on the audit trail; no path to a client record.
    audit_log: { read: 'always' },
  },

  /**
   * One cell, and it is the whole client-facing surface.
   *
   * Clients never authenticate into the staff application; they hold a link.
   * Reading behind that link and asking for a different time stay outside the
   * matrix, because neither changes anything. Confirming and declining do —
   * a decline cancels a session — so the capability is stated here rather than
   * assumed by whoever wrote the door. `token` still requires the row to be
   * theirs, so a link that names somebody else's appointment decides `never`.
   */
  client: { appointment: { update: 'token' } },

  /**
   * One cell, `unconditional`, and it is the entire public internet.
   *
   * `create` on `inquiry` and nothing else — no read, so a submitter cannot
   * learn that the practice already knows them, and no update, so nothing
   * already written can be altered by whoever writes next. There is no
   * relationship rule to attach because there is no identity: `unconditional`
   * says so out loud rather than reusing `always`, which reads as "any actor
   * in this role" and would be a dangerous thing to copy into a second cell.
   *
   * What actually bounds this cell is not the matrix — it is
   * `src/clients/public-inquiry.ts`: the practice's kill switch, the per
   * submitter ceiling, and a field set with nowhere to put a clinical
   * sentence. The matrix says what an anonymous request may do; that file says
   * how often and with what.
   */
  public: { inquiry: { create: 'unconditional' } },
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

/**
 * The staff member behind an act, or null when there is none.
 *
 * `Inquiry.takenById` is a foreign key to a real `User`, and a public form
 * submission has no such person — nobody took that call, it arrived. Deciding
 * that from the role is role logic, so it lives here rather than as an
 * `actor.role === 'public'` in the repository, which is the exact shape the
 * grep test refuses.
 */
export function actingStaffId(actor: Actor): string | null {
  return actor.role === 'public' ? null : actor.id;
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
