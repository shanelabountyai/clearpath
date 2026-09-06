import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BREAK_GLASS_CODES, BREAK_GLASS_REASONS, breakGlassLabel, isBreakGlassRef,
  isBreakGlassReason, parseBreakGlass, serialiseBreakGlass,
} from './break-glass';
import { DENY_LIST } from '../messaging/outbox';

/**
 * The reason attached to a break-glass session is the one piece of text the
 * administration tier writes into the clinical audit trail. These tests are
 * about the shape of that channel, not about any particular sentence: prose is
 * unfixable here, so there is no prose.
 */

describe('the reason is a code from a closed set', () => {
  it('accepts every code the product offers', () => {
    for (const code of BREAK_GLASS_CODES) expect(isBreakGlassReason(code)).toBe(true);
    expect(BREAK_GLASS_CODES.length).toBeGreaterThan(0);
  });

  it('refuses anything else, including the sentences this used to accept', () => {
    for (const not of [
      '',
      '   ',
      'client called the practice in distress and their clinician is on leave',
      'welfare check',
      'subpoena response, ref 2026-114',
      'SAFETY_CHECK',
      'safety_check ',
      'safety_check; client in crisis',
    ]) {
      expect(isBreakGlassReason(not), not).toBe(false);
    }
  });

  it('is not fooled by a property every object has', () => {
    // `v in REASONS` would answer true for these, and `constructor` is not a
    // reason anyone may open a clinical record with.
    for (const not of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isBreakGlassReason(not), not).toBe(false);
    }
  });

  it('refuses a non-string without throwing', () => {
    for (const not of [undefined, null, 3, {}, ['safety_check']]) {
      expect(isBreakGlassReason(not)).toBe(false);
    }
  });
});

describe('what the labels are allowed to say', () => {
  /**
   * The codes go in the table; the labels go on the auditor's screen. A label
   * describes the practice's situation — a rota, a request, a court order —
   * and never the client's state, so the deny-list the outbox uses to keep
   * clinical vocabulary out of a text message applies here too.
   *
   * This is the one place that argument is checkable, because it is the one
   * place the sentences are fixed in advance. That is the whole point of
   * closing the channel: a textarea could never be held to this.
   */
  it('no label uses a word the practice will not put in a client message', () => {
    for (const code of BREAK_GLASS_CODES) {
      const label = breakGlassLabel(code).toLowerCase();
      const found = DENY_LIST.filter((term) => label.includes(term));
      expect(found, `${code}: ${breakGlassLabel(code)}`).toEqual([]);
    }
  });

  it('every code has a label and no two share one', () => {
    const labels = BREAK_GLASS_CODES.map(breakGlassLabel);
    expect(labels.filter(Boolean)).toHaveLength(BREAK_GLASS_CODES.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('the codes and the table agree', () => {
    expect(BREAK_GLASS_CODES).toEqual(Object.keys(BREAK_GLASS_REASONS));
  });
});

describe('the case reference is an identifier, not a sentence', () => {
  it('takes a docket number', () => {
    for (const ref of ['2026-114', 'INV_88', 'a', 'ticket/2026/114', 'v1.2', '0'.repeat(32)]) {
      expect(isBreakGlassRef(ref), ref).toBe(true);
    }
  });

  it('refuses anything with a space, which is what a sentence needs', () => {
    // Not because these words are on a list — none of them are — but because
    // prose does not have the shape of an identifier.
    for (const ref of [
      'client rang in tears',
      'Jane Doe',
      'ref 2026-114',
      '',
      ' 2026-114',
      '0'.repeat(33),
      '-leading-punctuation',
    ]) {
      expect(isBreakGlassRef(ref), ref).toBe(false);
    }
  });
});

describe('reading a break-glass session off the request', () => {
  it('round-trips a code, with and without a reference', () => {
    for (const bg of [{ reason: 'legal_request' } as const, { reason: 'legal_request', ref: '2026-114' } as const]) {
      expect(parseBreakGlass(serialiseBreakGlass(bg))).toEqual(bg);
    }
  });

  it('is no session at all when the cookie is absent or empty', () => {
    expect(parseBreakGlass(undefined)).toBeUndefined();
    expect(parseBreakGlass('')).toBeUndefined();
  });

  /**
   * The cookie is `httpOnly`, which keeps a script in the browser out of it and
   * says nothing whatever about a request composed by hand. Before this, the
   * value went into the audit row unread: a crafted header wrote arbitrary text
   * into an append-only table, and it did not even have to pass the ten
   * characters the server action asked of the form.
   */
  it('refuses a hand-composed cookie rather than trusting it into the audit log', () => {
    for (const crafted of [
      'client called in distress',
      'safety_check; and also this',
      'safety_check:ref 2026-114',
      'safety_check:has spaces',
      '__proto__',
      'safety_check:' + '0'.repeat(33),
    ]) {
      expect(parseBreakGlass(crafted), crafted).toBeUndefined();
    }
  });

  it('keeps only the first colon, so a reference cannot smuggle a second field', () => {
    expect(parseBreakGlass('legal_request:2026-114:extra')).toBeUndefined();
  });
});

/**
 * Nothing but the guard writes an audit row.
 *
 * The type on `Actor['breakGlass']` is what keeps prose out of the reason: a
 * sentence no longer compiles anywhere an actor is built, which is a stronger
 * guarantee than any lint. It has one gap — code that writes to the table
 * directly, without going through an `Actor` at all — and that is the same gap
 * hard rule 4 cares about, because a row written outside `record()` is an
 * access nobody decided and a reason nobody validated.
 *
 * Written as a sweep of the tree rather than a list of files, for the reason
 * the role-check and author-only lints are: a list cannot cover the module
 * added next month.
 */
it('only the guard writes to the audit log', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path === 'src/auth/guard.ts' || path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      if (/\bauditEvent\s*\.\s*(create|createMany|upsert)\b/.test(readFileSync(path, 'utf8'))) {
        offenders.push(path);
      }
    }
  }
  expect(offenders).toEqual([]);
});

it('recognises a direct write however it is spelled', () => {
  // The lint's own fixtures. Without these it is a regex nobody has watched
  // fail, which is the failure mode `271674c` found in the role-check lint.
  const bad = [
    'await tx.auditEvent.create({ data: { reason } })',
    'prisma.auditEvent.createMany({ data: rows })',
    'db . auditEvent . create ({})',
    'tx.auditEvent.upsert({ where: {} })',
  ];
  const good = [
    'const rows = await tx.auditEvent.findMany({ where })',
    'await tx.auditEvent.count({ where })',
    'auditEvent(actor, "read", "client")',
  ];
  const lint = /\bauditEvent\s*\.\s*(create|createMany|upsert)\b/;
  for (const s of bad) expect(lint.test(s), s).toBe(true);
  for (const s of good) expect(lint.test(s), s).toBe(false);
});
