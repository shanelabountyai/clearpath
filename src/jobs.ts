import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from './clock';
import { runInquiryPurge } from './clients/inquiry';
import { runReminderHorizon } from './scheduling/reminders';
import { runLeaveAlertSweep } from './staff/leave-plan';
import { runProcessNotePurge } from './staff/departure';

/**
 * The two scheduled runners, stated once. `npm run reminders:run` and
 * `purge:run` call these, and so do the Vercel Cron routes under
 * `app/api/cron`, so a sweep added to a runner cannot reach one door and not
 * the other.
 *
 * Counts only. An id in a cron response or a log line is a caller, or a note.
 */

/**
 * The reminder horizon, then the leave alert sweep. The sweep rides here and
 * not on the purge (leave Phase 3). It has this runner's property exactly:
 * idempotent, and late rather than wrong when missed. Lateness is its whole
 * cost, because an unread critical alert left for a nightly purge could sit
 * with somebody away for most of a day. The purge keeps its own schedule
 * because its sweeps destroy data, and this one destroys nothing.
 */
export async function remindersRun(clock: Clock) {
  const { queued, promoted, exempted } = await runReminderHorizon(clock);
  const moved = await runLeaveAlertSweep(clock);
  return { queued: queued.length, promoted: promoted.length, exempted: exempted.length, alertsMoved: moved.length };
}

/**
 * Every retention window in the practice, on one path. The two sweeps share
 * nothing except that both destroy rows once a window has passed, and that is
 * why they share a runner: a second schedule is a second thing to forget, and
 * the forgotten one would be the job that makes data stop existing. They stay
 * separate functions, because their windows, invariants and refusing triggers
 * differ.
 */
export async function purgeRun(clock: Clock) {
  const inquiries = await runInquiryPurge(clock);
  const processNotes = await runProcessNotePurge(clock);
  return { inquiries: inquiries.length, processNotes: processNotes.length };
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
