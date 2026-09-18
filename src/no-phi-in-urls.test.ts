import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchesSearch } from './ui/client-search';
import { auditCodeOrNothing } from './reports/audit-code';

/**
 * Hard rule 3's build-time test (PRD 1, Q4). Rules 1 and 2 had source-grepping
 * tests and did not drift; rule 3 had none, and `/clients?q=Jane+Doe` shipped.
 *
 * Every query-string key any page or route reads must be on this list: ids,
 * dates, codes, cursors and flags. A new key fails the build until someone
 * decides it can never carry a name. It fails closed — a file that touches
 * `searchParams` in a shape this test cannot read is an offender too.
 *
 * Checks key names, not values. `?error=` and `?sendFailed=` carry a
 * `Conflict`'s code, never its message; the test below holds that.
 */
const APPROVED = new Set([
  // ids and codes
  'clientId', 'clinicianId', 'actorId', 'template', 'resource', 'status', 'type', 'modality',
  'convert', 'fee', 'lang',
  // a reason is validated against AUDIT_CODE before anything reads it
  'reason',
  // dates and paging
  'date', 'from', 'to', 'cursor',
  // flags and outcome codes after a redirect
  'flagged', 'denied', 'booked', 'skipped', 'assigned', 'converted', 'recorded', 'sendFailed', 'sent',
  'asked', 'confirmed', 'declined', 'error',
]);

function keysRead(src: string): string[] | 'unreadable' {
  const keys: string[] = [];
  const typed = /searchParams:\s*Promise<\s*\{([^}]*)\}/.exec(src);
  if (typed) keys.push(...[...typed[1]!.matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]!));
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+searchParams/g)) {
    keys.push(...m[1]!.split(',').map((k) => k.split(':')[0]!.trim()).filter(Boolean));
  }
  const vars = [
    ...[...src.matchAll(/const\s+(\w+)\s*=\s*await\s+searchParams/g)].map((m) => m[1]!),
    ...[...src.matchAll(/const\s+(\w+)\s*=\s*new URL\([^)]*\)\.searchParams/g)].map((m) => m[1]!),
  ];
  for (const v of vars) {
    keys.push(...[...src.matchAll(new RegExp(`\\b${v}\\.(?!get\\b)(\\w+)`, 'g'))].map((m) => m[1]!));
    keys.push(...[...src.matchAll(new RegExp(`\\b${v}\\.get\\('(\\w+)'\\)`, 'g'))].map((m) => m[1]!));
  }
  if (keys.length === 0 || /useSearchParams/.test(src)) return 'unreadable';
  return keys;
}

describe('hard rule 3: no free-text key in a URL', () => {
  it('every query-string key read in app/ is on the approved list', () => {
    const offenders: string[] = [];
    for (const f of readdirSync('app', { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(f)) continue;
      const src = readFileSync(`app/${f}`, 'utf8');
      if (!/searchParams/.test(src)) continue;
      const keys = keysRead(src);
      if (keys === 'unreadable') offenders.push(`app/${f}: searchParams in a shape this test cannot read`);
      else for (const k of keys) if (!APPROVED.has(k)) offenders.push(`app/${f}: ?${k}=`);
    }
    expect(offenders).toEqual([]);
  });

  it('catches the defect it was written for', () => {
    expect(keysRead(`({ searchParams }: { searchParams: Promise<{ q?: string }> }) => { const { q } = await searchParams; }`))
      .toContain('q');
    expect(keysRead(`const q = await searchParams; q.topic;`)).toContain('topic');
    expect(keysRead(`const p = new URL(request.url).searchParams; p.get('name');`)).toContain('name');
    expect(keysRead(`const s = useSearchParams(); searchParams`)).toBe('unreadable');
  });
});

/**
 * A `Conflict` message is prose written by whoever wrote the throw, and the
 * first one to name a client would ship to the URL unnoticed (review F4). A
 * redirect carries the code; the page owns the sentence.
 *
 * ponytail: matches `.message` on the redirect's line or inside a `back({...})`
 * object literal, which is every shape the app uses. A message laundered
 * through a variable first would get past it.
 */
function messageInUrl(src: string): boolean {
  return /redirect\([^\n]*\.message/.test(src) || /back\(\{[^}]*\.message/.test(src);
}

describe('hard rule 3: no error message in a URL', () => {
  it('no redirect in app/ carries a Conflict message', () => {
    const offenders = readdirSync('app', { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && messageInUrl(readFileSync(`app/${f}`, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('catches the defect it was written for', () => {
    expect(messageInUrl('redirect(`/appointments/${id}?error=${encodeURIComponent(e.message)}`);')).toBe(true);
    expect(messageInUrl("back({ convert: id, error: e.message });")).toBe(true);
    expect(messageInUrl("back({ error: e.code ?? 'conflict' });")).toBe(false);
    // The group form's refusal travels in the response body, not a URL.
    expect(messageInUrl('return back(e.message);')).toBe(false);
  });
});

describe('client search (PRD 1, Q2)', () => {
  it('matches every word, in any field, in any case', () => {
    expect(matchesSearch('Jane Doe C-1042', 'jane')).toBe(true);
    expect(matchesSearch('Jane Doe C-1042', 'doe jane')).toBe(true);
    expect(matchesSearch('Jane Doe C-1042', 'c-1042')).toBe(true);
    expect(matchesSearch('Jane Doe C-1042', 'jane smith')).toBe(false);
    expect(matchesSearch('Jane Doe C-1042', '  ')).toBe(true);
  });
});

describe('audit reason filter (PRD 1, Q3)', () => {
  it('passes a code and drops anything else', () => {
    expect(auditCodeOrNothing('leave:returned')).toBe('leave:returned');
    expect(auditCodeOrNothing('Jane Doe')).toBeUndefined();
    expect(auditCodeOrNothing('leave:Jane Doe')).toBeUndefined();
    expect(auditCodeOrNothing(null)).toBeUndefined();
  });
});
