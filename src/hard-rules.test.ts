import { describe, expect, it } from 'vitest';
import { callArgs, objectAt, readSource, sourceFiles } from './test/source';

/**
 * Hard rules 3, 8 and 9, asserted on the shape of the source, the same way
 * rules 1, 2 and 7 already are. Each guard is a function over [path, source]
 * pairs so its planted offenders can prove it goes red.
 */
const files = () => sourceFiles().map((p): [string, string] => [p, readSource(p)]);

// ---------------------------------------------------------------------------
// Hard rule 3: a log line or an error message carries ids and codes, never a
// value out of the record. Fails closed: whatever a message interpolates must
// look like an id, a status or a count, or the build stops until someone
// decides it can never carry a name.

/** The expressions in `src`: string text dropped, `${...}` kept. */
function expressions(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'" || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      out += ' ';
    } else if (c === '`') {
      for (i++; i < src.length && src[i] !== '`'; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] !== '$' || src[i + 1] !== '{') continue;
        let depth = 0, j = i + 1;
        for (; j < src.length; j++) if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break;
        out += ` ${expressions(src.slice(i + 2, j))} `;
        i = j;
      }
      out += ' ';
    } else out += c;
  }
  return out;
}

/** An error's kind, never its message: `typeof e`, `e instanceof Error`. */
const ERROR_KIND = /\btypeof\s+[\w$]+|[\w$]+\s+instanceof\s+[\w$]+/g;
const HARMLESS = /^(?:new|typeof|instanceof|Error|true|false|null|undefined|(?:e|err|error)\.name)$/;
// Code-shaped names: a template's key, a form field's key, a permission cell.
const ID_LIKE = /(?:^|\.)(?:id|ids|\w+(?:Ids?|Keys?)|key|version|field|resource|action|conflict|status|phase|code|length)(?:\.join)?$|^(?:from|to)$/;
const SINK = /\bconsole\s*\.\s*\w+|\bnew\s+(?:\w*Error|Conflict|NotFound|Forbidden)\b/g;

// ponytail: judges names, not values — `const clientId = client.lastName`
// passes. A TypeScript-AST pass that follows assignments is the upgrade.
function leaks(args: string): string[] {
  const code = expressions(args.slice(1, -1)).replace(ERROR_KIND, ' ');
  return [...code.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/g)]
    .map((m) => m[0].replace(/\?\./g, '.'))
    .filter((c) => !HARMLESS.test(c) && !ID_LIKE.test(c));
}

function phiInMessages(sources: [string, string][]): string[] {
  const offenders: string[] = [];
  for (const [path, src] of sources) {
    // Its messages name environment variables, read before any record exists.
    if (path === 'src/env.ts') continue;
    for (const m of src.matchAll(SINK)) {
      const at = (m.index ?? 0) + m[0].length;
      // `const log = console.error` or `.catch(console.error)`: the arguments
      // are somewhere this test cannot see.
      if (!/^\s*\(/.test(src.slice(at))) { offenders.push(`${path}: ${m[0]} not called in place`); continue; }
      for (const leak of leaks(callArgs(src, at))) offenders.push(`${path}: ${m[0]}(… ${leak} …)`);
    }
  }
  return offenders;
}

describe('hard rule 3: no PHI in a log line or an error message', () => {
  it('every console call and error message interpolates only ids, statuses and counts', () => {
    expect(phiInMessages(files())).toEqual([]);
  });

  it.each([
    'console.log(client.firstName)',
    "console.error('save failed', e)",
    "console.error('save failed', e.message)",
    "console.warn(`reply from ${sender.phone}`)",
    "console.info('answers', JSON.stringify(answers))",
    "throw new Error(`no slot for ${client.lastName}`)",
    "throw new Conflict('Client ' + client.email + ' exists', 'duplicate')",
    "throw new Conflict(message, 'bad')",
    "throw new NotFound(`note ${note.content}`)",
    "throw new Error('failed', { cause: e })",
    "promise.catch(console.error)",
    "const log = console.log; log(client.dateOfBirth)",
  ])('the message guard catches %s', (src) => {
    expect(phiInMessages([['planted.ts', src]])).not.toEqual([]);
  });

  it.each([
    "console.error('note save failed', id, e instanceof Error ? e.name : typeof e)",
    "throw new Conflict(`A ${from} session cannot become ${to}`, 'bad_transition')",
    "throw new Error(`appointment ${appt.id} passed eligibility`)",
    "throw new Conflict(`This departure has ${blockers.length} unresolved item(s)`, 'departure_not_ready')",
    "throw new Conflict(`A ${row.status} inquiry cannot be assigned`, 'bad_transition')",
    "throw new Conflict('it said \\'no\\'', 'declined')",
    "throw new Conflict(`Template ${template.key} is missing: ${untranslatedKeys.join(', ')}`, 'x', fieldKeys)",
  ])('and lets an id-only message through: %s', (src) => {
    expect(phiInMessages([['planted.ts', src]])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hard rule 8: a session's status changes in lifecycle.ts, where `transition`
// checks the table. The one write allowed elsewhere is a bulk cancel bounded
// by `UNSTARTED` — the set the table derives for exactly that edge — which the
// series withdrawal, a group cancel and a departure all need in one statement.

const APPOINTMENT_WRITE = /\.appointment\s*\.\s*(?:create|createMany|update|updateMany|upsert)\b/g;

function scatteredStatusWrites(sources: [string, string][]): string[] {
  const offenders: string[] = [];
  for (const [path, src] of sources) {
    if (/(?:UPDATE|INSERT\s+INTO)\s+"Appointment"/i.test(src)) offenders.push(`${path}: raw SQL write`);
    if (/\bappointments?\s*:\s*\{\s*(?:create|createMany|update|updateMany|upsert)\s*:\s*[{[]/.test(src)) {
      offenders.push(`${path}: nested appointment write`);
    }
    if (path === 'src/scheduling/lifecycle.ts') continue;
    for (const m of src.matchAll(APPOINTMENT_WRITE)) {
      const args = callArgs(src, (m.index ?? 0) + m[0].length);
      const where = objectAt(args, 'where');
      const rest = args.replace(where, '');
      // `data: patch` or `{ where, data }`: a status could be anywhere in it.
      if (/\bdata\s*(?::\s*[\w$.]+\s*)?[,}]/.test(rest)) { offenders.push(`${path}: ${m[0]} with opaque data`); continue; }
      const data = objectAt(rest, 'data') || rest;
      if (/\bstatus\s*[,}]/.test(data)) { offenders.push(`${path}: ${m[0]} status shorthand`); continue; }
      const statuses = [...data.matchAll(/\bstatus\s*:\s*([^,}\n]+)/g)].map((s) => s[1]!.trim());
      if (!statuses.length) continue;
      const whereVar = /\bwhere\s*:\s*(\w+)/.exec(args)?.[1];
      const bounded = where.includes('UNSTARTED')
        || (!!whereVar && new RegExp(`const\\s+${whereVar}\\s*=\\s*\\{[^;]*\\bUNSTARTED\\b`).test(src));
      if (!bounded || statuses.some((s) => s !== "'cancelled'")) offenders.push(`${path}: ${m[0]} sets status ${statuses.join(', ')}`);
    }
  }
  return offenders;
}

describe('hard rule 8: session status changes only through the state machine', () => {
  it('outside lifecycle.ts, the only status write is a cancel bounded by UNSTARTED', () => {
    expect(scatteredStatusWrites(files())).toEqual([]);
  });

  it.each([
    "tx.appointment.update({ where: { id }, data: { status: 'completed' } })",
    "tx.appointment.updateMany({ where: { id: { in: ids } }, data: { status: 'cancelled' } })",
    "tx.appointment.updateMany({ where: { status: { in: UNSTARTED } }, data: { status: 'late_cancelled' } })",
    "tx.appointment.update({ where: { id }, data: { status } })",
    "tx.appointment.update({ where: { id }, data: patch })",
    "tx.appointment.update({ where, data })",
    "tx.appointment.create({ data: { clientId, status: 'arrived' } })",
    "tx.appointment.upsert({ where: { id }, create: { clientId }, update: { status: 'no_show' } })",
    "tx.client.update({ where: { id }, data: { appointments: { updateMany: { where: {}, data: { status: 'cancelled' } } } } })",
    'tx.$executeRaw`UPDATE "Appointment" SET status = \'completed\'`',
  ])('the status guard catches %s', (src) => {
    expect(scatteredStatusWrites([['planted.ts', src]])).not.toEqual([]);
  });

  it.each([
    "tx.appointment.updateMany({ where: { id: { in: ids }, status: { in: UNSTARTED } }, data: { status: 'cancelled', cancelledAt: now } })",
    "const future = { clientId, status: { in: UNSTARTED } }; tx.appointment.updateMany({ where: future, data: { status: 'cancelled' } })",
    "tx.appointment.update({ where: { id, status: current.status }, data: { startAt, endAt } })",
    "tx.appointment.update({ where: { id }, data: { confirmation: 'confirmed' } })",
    "const MATRIX = { appointment: { update: 'token' } }",
  ])('and lets a bounded cancel or a status-free write through: %s', (src) => {
    expect(scatteredStatusWrites([['planted.ts', src]])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hard rule 9: an alert's recipient comes from `staff/coverage.ts` — the
// treating clinician, or their coverer on a day they are away — and from
// nowhere else. `coverage.test.ts` pins who those functions pick; this pins
// that every alert write asks them.

const ALERT_WRITE = /\.alert\s*\.\s*(create|createMany|update|updateMany|upsert)\b/g;

function unroutedAlerts(sources: [string, string][]): string[] {
  const offenders: string[] = [];
  for (const [path, src] of sources) {
    if (/(?:UPDATE|INSERT\s+INTO)\s+"Alert"/i.test(src)) offenders.push(`${path}: raw SQL write`);
    if (/\balerts?\s*:\s*\{\s*(?:create|createMany|connect|connectOrCreate|set|update|updateMany|upsert)\s*:\s*[{[]/.test(src)) {
      offenders.push(`${path}: nested alert write`);
    }
    const routeMaps = new Set([...src.matchAll(/(\w+)\s*=\s*await\s+routesOf\(/g)].map((r) => r[1]!));
    const routed = new Set(
      [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+alertRecipient\(|(\w+)\.get\()/g)]
        .filter((r) => !r[2] || routeMaps.has(r[2]))
        .map((r) => r[1]!),
    );
    for (const m of src.matchAll(ALERT_WRITE)) {
      const args = callArgs(src, (m.index ?? 0) + m[0].length);
      const rest = args.replace(objectAt(args, 'where'), '');
      if (/recipient/.test(rest)) { offenders.push(`${path}: ${m[0]} names its recipient`); continue; }
      const sources = [
        ...[...rest.matchAll(/\.\.\.\s*(\(\s*await\s+alertRecipient\(|[\w$]+|\S)/g)].map((s) => s[1]!),
        ...[...rest.matchAll(/\bdata\s*:\s*([\w$]+)\s*[,}]/g)].map((s) => s[1]!),
      ];
      if (/\bdata\s*[,}]/.test(rest)) sources.push('data');
      const unrouted = sources.filter((s) => !s.includes('alertRecipient') && !routed.has(s));
      if (unrouted.length) offenders.push(`${path}: ${m[0]} from ${unrouted.join(', ')}`);
      else if (m[1]!.startsWith('create') && !sources.length) offenders.push(`${path}: ${m[0]} with no route`);
    }
  }
  return offenders;
}

describe('hard rule 9: an alert reaches the treating clinician, through coverage', () => {
  it('every alert write takes its recipient from alertRecipient or routesOf', () => {
    expect(unroutedAlerts(files())).toEqual([]);
  });

  it.each([
    "tx.alert.create({ data: { recipientId: frontDesk.id, clientId, kind } })",
    "tx.alert.create({ data: { recipient: { connect: { id } }, clientId, kind } })",
    "tx.alert.create({ data: { clientId, kind } })",
    "const to = { recipientId: inbox }; tx.alert.create({ data: { ...to, clientId, kind } })",
    "const to = others.get(id); tx.alert.create({ data: { ...to, clientId, kind } })",
    "tx.alert.update({ where: { id }, data: whoever })",
    "tx.alert.updateMany({ where: { recipientId: a }, data: { recipientId: b } })",
    "tx.alert.update({ where, data })",
    "tx.client.update({ where: { id }, data: { alerts: { create: { recipientId, kind } } } })",
    'tx.$executeRaw`INSERT INTO "Alert" ("recipientId") VALUES (${id})`',
  ])('the alert guard catches %s', (src) => {
    expect(unroutedAlerts([['planted.ts', src]])).not.toEqual([]);
  });

  it.each([
    "tx.alert.create({ data: { ...(await alertRecipient(tx, id, today)), clientId, kind } })",
    "const to = await alertRecipient(tx, id, today); tx.alert.create({ data: { ...to, clientId, kind } })",
    "const routes = await routesOf(tx, cs, today); const to = routes.get(a.clientId)!; tx.alert.update({ where: { id: a.id }, data: to })",
    "tx.alert.update({ where: { id: alertId, recipientId: actor.id }, data: { acknowledgedAt: now } })",
    "const MATRIX = { alert: { update: 'treating' } }",
  ])('and lets a routed or recipient-free write through: %s', (src) => {
    expect(unroutedAlerts([['planted.ts', src]])).toEqual([]);
  });
});
