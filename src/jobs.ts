import { createHash, timingSafeEqual } from 'node:crypto';
import { DAY, HOUR, type Clock } from './clock';
import { prisma } from './db';
import { runInquiryPurge } from './clients/inquiry';
import { runReminderHorizon } from './scheduling/reminders';
import { runLeaveAlertSweep } from './staff/leave-plan';
import { runProcessNotePurge } from './staff/departure';
import { runNonResponseSweep } from './scheduling/nonresponse';

/**
 * The three scheduled runners, stated once. `npm run reminders:run`,
 * `purge:run` and `nonresponse:run` call these, and so do the Vercel Cron
 * routes under `app/api/cron`, so a sweep added to a runner cannot reach one
 * door and not the other.
 *
 * `delivery:run` is the fourth command and deliberately has no runner here.
 * Half of it is schedulable and half of it invents the evidence a fee rests
 * on; the argument is written on `scripts/delivery-run.ts`, where somebody
 * reaching for the cron entry will already be standing.
 *
 * Counts only. An id in a cron response or a log line is a caller, or a note.
 */

/**
 * The three jobs, their schedules said in words, and how long silence from
 * one is allowed to last before it means something.
 *
 * `job` is the route directory under `app/api/cron` and the path in
 * `vercel.json`; the wiring test in `jobs.test.ts` holds all three to the same
 * three names, so a job cannot be recorded under a name nothing watches, or
 * watched under a name nothing records.
 *
 * `overdueAfter` is two ticks, not one. These runners are deliberately late
 * rather than wrong when missed — the argument is written on each of them — so
 * a single skipped hour is not news. Two in a row is: nothing that is running
 * misses two.
 */
export const SCHEDULED = [
  { job: 'reminders', when: 'Hourly, on the hour', overdueAfter: 2 * HOUR },
  { job: 'nonresponse', when: 'Hourly, at half past', overdueAfter: 2 * HOUR },
  { job: 'purge', when: 'Daily at 08:00', overdueAfter: DAY + 2 * HOUR },
] as const;

export type JobName = (typeof SCHEDULED)[number]['job'];

/**
 * Run the work, and leave a row saying it happened.
 *
 * Deliberately outside any transaction the work opens: a run that failed has
 * to leave the record of failing, and a row that rolls back with the thing it
 * was describing is exactly the silence this table exists to break.
 *
 * A failure to record a failure is swallowed. The original exception is what a
 * person needs, and masking it with a database error thrown on the way out
 * would cost them the one thing the platform log does hold.
 *
 * Exported so the failing branch has a test. Nothing outside this file calls
 * it: a job that wants recording gets a runner here, which is the same reason
 * the runners themselves live in one file.
 */
export async function recorded<T extends object>(job: JobName, clock: Clock, work: () => Promise<T>): Promise<T> {
  const at = clock.now();
  try {
    const counts = await work();
    await prisma.jobRun.create({ data: { job, at, ok: true, counts } });
    return counts;
  } catch (err) {
    const error = err instanceof Error ? err.constructor.name : 'unknown';
    await prisma.jobRun.create({ data: { job, at, ok: false, error } }).catch(() => {});
    throw err;
  }
}

export interface JobStatus {
  job: JobName;
  when: string;
  lastAt: Date | null;
  ok: boolean;
  counts: unknown;
  error: string | null;
  /** No run inside the window. The only signal that survives the job not running at all. */
  overdue: boolean;
}

/**
 * What each scheduled job last did, and whether it has gone quiet.
 *
 * Reads no client data, and so is not guarded and writes no audit row — for
 * the reason `may()` gives for staying silent: a row per page render would
 * bury the accesses the log exists for. It is still only reached from a page
 * whose own guard has already run.
 *
 * ponytail: pull, not push. A stopped job is caught the next time somebody
 * opens the Practice page rather than when it stops, because the application
 * has one outbound channel and it goes to clients — hard rule 9 keeps clinical
 * alerts off a shared inbox, and a job failure has no treating clinician to
 * route to. Upgrade path is an operations channel, and it is the channel that
 * is missing here, not the detection.
 */
export async function jobHealth(clock: Clock): Promise<JobStatus[]> {
  const now = clock.now().getTime();
  const last = await Promise.all(
    SCHEDULED.map(({ job }) => prisma.jobRun.findFirst({ where: { job }, orderBy: { at: 'desc' } })),
  );
  return SCHEDULED.map((s, i) => ({
    job: s.job,
    when: s.when,
    lastAt: last[i]?.at ?? null,
    ok: last[i]?.ok ?? false,
    counts: last[i]?.counts ?? null,
    error: last[i]?.error ?? null,
    overdue: !last[i] || now - last[i]!.at.getTime() > s.overdueAfter,
  }));
}

/**
 * The reminder horizon, then the leave alert sweep. The sweep rides here and
 * not on the purge (leave Phase 3). It has this runner's property exactly:
 * idempotent, and late rather than wrong when missed. Lateness is its whole
 * cost, because an unread critical alert left for a nightly purge could sit
 * with somebody away for most of a day. The purge keeps its own schedule
 * because its sweeps destroy data, and this one destroys nothing.
 */
export function remindersRun(clock: Clock) {
  return recorded('reminders', clock, async () => {
    const { queued, promoted, exempted } = await runReminderHorizon(clock);
    const moved = await runLeaveAlertSweep(clock);
    return { queued: queued.length, promoted: promoted.length, exempted: exempted.length, alertsMoved: moved.length };
  });
}

/**
 * Every retention window in the practice, on one path. The two sweeps share
 * nothing except that both destroy rows once a window has passed, and that is
 * why they share a runner: a second schedule is a second thing to forget, and
 * the forgotten one would be the job that makes data stop existing. They stay
 * separate functions, because their windows, invariants and refusing triggers
 * differ.
 */
export function purgeRun(clock: Clock) {
  return recorded('purge', clock, async () => {
    const inquiries = await runInquiryPurge(clock);
    const processNotes = await runProcessNotePurge(clock);
    return { inquiries: inquiries.length, processNotes: processNotes.length };
  });
}

/**
 * Silence, swept on its own schedule.
 *
 * It does not ride the reminder runner, and the reason is the one written on
 * `runNonResponseSweep`: that runner touches no money, and this is the only
 * automatic path to a charge in the application. Sharing one would mean the
 * only way to stop the practice billing for silence is to stop reminding
 * anybody — a change somebody makes at 2am during an incident, and the one
 * they would get wrong.
 *
 * It has the property that earns a schedule, though, and it is the reminder
 * runner's: `pending` is the only state it acts on and it leaves
 * `no_response`, so a second run inside the hour finds nothing, and a missed
 * hour costs only lateness. Lateness here is a front-desk work list that does
 * not yet show who went quiet.
 *
 * Runs at :30, half an hour off the horizon at :00. Nothing depends on the
 * order — they are two sweeps with no reason to contend.
 */
export function nonResponseRun(clock: Clock) {
  return recorded('nonresponse', clock, async () => {
    const sweep = await runNonResponseSweep(clock);
    return { recorded: sweep.recorded.length, noShowed: sweep.noShowed.length };
  });
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Fails closed: with
 * no secret configured nothing is authorized, so the literal header
 * `Bearer undefined` is not a way in. The comparison is over digests, so it
 * runs in constant time whatever the header's length.
 */
export function cronAuthorized(header: string | null, secret = process.env.CRON_SECRET): boolean {
  if (!secret || !header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
