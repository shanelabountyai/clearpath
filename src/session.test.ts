import { describe, expect, it } from 'vitest';
import { serialiseBreakGlass } from './auth/break-glass';
import { sessionFor } from './session';

/**
 * The seam that turns a cookie into an actor.
 *
 * Every permission decision in the product starts from what this returns, and
 * until now nothing exercised it: the module had no test file at all. The
 * matrix is thoroughly tested about what an actor of a given role may do, and
 * said nothing about who the actor is.
 */
const row = (over: Partial<Parameters<typeof sessionFor>[0] & object> = {}) => ({
  id: 'u1', name: 'Rosa Iyer', role: 'supervisor' as const, supervisorId: null, active: true, ...over,
});

describe('who a request is', () => {
  it('is nobody when the cookie names no user', () => {
    expect(sessionFor(null, undefined)).toBeNull();
  });

  it('is nobody when the cookie names a deactivated user', () => {
    // Deactivating somebody has to end their access. The cookie in their
    // browser outlives the decision to remove them, and this is the only place
    // that decision is enforced on an existing session.
    expect(sessionFor(row({ active: false }), undefined)).toBeNull();
  });

  it('carries the id and role the matrix will judge, and nothing else', () => {
    expect(sessionFor(row(), undefined)!.actor).toEqual({ id: 'u1', role: 'supervisor' });
  });
});

describe('the break-glass cookie', () => {
  it('attaches a well-formed session to the actor', () => {
    const cookie = serialiseBreakGlass({ reason: 'legal_request', ref: '2026-114' });
    expect(sessionFor(row({ role: 'admin' }), cookie)!.actor.breakGlass)
      .toEqual({ reason: 'legal_request', ref: '2026-114' });
  });

  it('is simply absent when the value is not one, rather than an error', () => {
    // The cookie is the trust boundary, and a request composed by hand can put
    // anything here. Each of these is refused in the ordinary way instead of
    // becoming a session or a stack trace — including the one that tries to
    // carry prose in the reference field.
    for (const bad of [
      '',
      'not_a_reason',
      'legal_request:client rang in tears',
      `legal_request:${'x'.repeat(40)}`,
    ]) {
      expect(sessionFor(row({ role: 'admin' }), bad)!.actor.breakGlass).toBeUndefined();
    }
  });
});

describe('the second factor', () => {
  it('is required for the roles that reach notes, and the manager who can break glass', () => {
    for (const role of ['therapist', 'associate', 'supervisor', 'admin'] as const) {
      expect(sessionFor(row({ role }), undefined)!.secondFactor.required).toBe(true);
    }
    for (const role of ['front_desk', 'auditor'] as const) {
      expect(sessionFor(row({ role }), undefined)!.secondFactor.required).toBe(false);
    }
  });

  it('is never satisfied, because there is no authentication here to satisfy it', () => {
    // A check that always passed would read as a control. See WRITEUP.md,
    // "Where authentication would attach".
    for (const role of ['therapist', 'admin', 'front_desk'] as const) {
      expect(sessionFor(row({ role }), undefined)!.secondFactor.satisfied).toBe(false);
    }
  });
});
