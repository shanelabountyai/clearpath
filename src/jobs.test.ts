import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, fixedClock } from './clock';
import { prisma } from './db';
import { resetDb } from './test/harness';
import { SCHEDULED, cronAuthorized, jobHealth, purgeRun, recorded } from './jobs';

describe('cronAuthorized', () => {
  it('accepts exactly the bearer Vercel Cron sends', () => {
    expect(cronAuthorized('Bearer s3cret', 's3cret')).toBe(true);
  });

  it.each([
    ['no header', null],
    ['empty header', ''],
    ['wrong secret', 'Bearer nope'],
    ['bare secret without the scheme', 's3cret'],
    ['secret as a prefix', 'Bearer s3cret-and-more'],
    ['lowercase scheme', 'bearer s3cret'],
  ])('refuses %s', (_, header) => {
    expect(cronAuthorized(header, 's3cret')).toBe(false);
  });

  it.each([undefined, ''])('fails closed when the secret is %j', (secret) => {
    expect(cronAuthorized('Bearer undefined', secret)).toBe(false);
    expect(cronAuthorized('Bearer ', secret)).toBe(false);
  });
});

/**
 * The thread that produced this file's third runner: `nonresponse:run` existed
 * for weeks with no schedule and nothing said so. A door with no schedule
 * never runs, and a schedule with no door is an hourly 404 nobody reads.
 */
describe('cron wiring', () => {
  it('has a route for every schedule and a schedule for every route', () => {
    const { crons } = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const scheduled = crons.map((c: { path: string }) => c.path).sort();
    const routes = readdirSync('app/api/cron').map((d) => `/api/cron/${d}`).sort();
    expect(scheduled).toEqual(routes);
  });

  /**
   * The third name, added with the run record. A job recorded as `purge` and
   * watched as `purges` is a badge that is green because nothing ever looks at
   * it — the exact failure the table was built to make impossible.
   */
  it('watches every job by the name its route and schedule use', () => {
    const watched = SCHEDULED.map((s) => `/api/cron/${s.job}`).sort();
    expect(watched).toEqual(readdirSync('app/api/cron').map((d) => `/api/cron/${d}`).sort());
  });
});

const NOON = new Date('2026-09-15T12:00:00Z');

describe('the run record', () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it('leaves a row carrying what the runner returned', async () => {
    const counts = await purgeRun(fixedClock(NOON));

    const rows = await prisma.jobRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ job: 'purge', ok: true, error: null, at: NOON });
    expect(rows[0]!.counts).toEqual(counts);
  });

  /**
   * Hard rule 3 reaches the monitoring table too. A Prisma error quotes the
   * row that caused it, so the message is the one field that could turn this
   * table into the place a client's name leaks to — the class name is what a
   * person needs to know which log to open, and it is all that is kept.
   */
  it('records a failure by class name and keeps nothing of the message', async () => {
    const boom = new TypeError('client Rosa Alvarez has no appointment row');

    await expect(recorded('purge', fixedClock(NOON), async () => { throw boom; })).rejects.toBe(boom);

    const [row] = await prisma.jobRun.findMany();
    expect(row).toMatchObject({ job: 'purge', ok: false, error: 'TypeError', counts: null });
    expect(JSON.stringify(row)).not.toContain('Rosa');
  });
});

/**
 * The signal that survives the job not running at all. A 500 announces itself
 * in the platform log; a cron that stopped firing, or a route answering 401
 * because its secret was never set, announces nothing — so absence has to be
 * the thing that speaks.
 */
describe('jobHealth', () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  const at = (t: Date) => jobHealth(fixedClock(t));
  const plus = (ms: number) => new Date(NOON.getTime() + ms);

  it('calls a job that has never run overdue', async () => {
    expect(await at(NOON)).toEqual(
      SCHEDULED.map((s) => ({ job: s.job, when: s.when, lastAt: null, ok: false, counts: null, error: null, overdue: true })),
    );
  });

  it('clears on a run and goes overdue again after two ticks of silence', async () => {
    await purgeRun(fixedClock(NOON));
    const purgeAt = async (t: Date) => (await at(t)).find((j) => j.job === 'purge')!;

    expect(await purgeAt(plus(HOUR))).toMatchObject({ ok: true, overdue: false, lastAt: NOON });
    expect(await purgeAt(plus(DAY + HOUR))).toMatchObject({ overdue: false });
    expect(await purgeAt(plus(DAY + 3 * HOUR))).toMatchObject({ overdue: true });

    // The other two never ran, and one job succeeding says nothing about them.
    expect((await at(plus(HOUR))).filter((j) => j.overdue).map((j) => j.job))
      .toEqual(['reminders', 'nonresponse']);
  });

  it('shows a failed run as failed while it is still recent, and overdue once it is not', async () => {
    await expect(recorded('reminders', fixedClock(NOON), async () => { throw new RangeError('x'); })).rejects.toThrow();
    const remindersAt = async (t: Date) => (await at(t)).find((j) => j.job === 'reminders')!;

    expect(await remindersAt(plus(HOUR))).toMatchObject({ ok: false, error: 'RangeError', overdue: false });
    expect(await remindersAt(plus(3 * HOUR))).toMatchObject({ ok: false, overdue: true });
  });
});
