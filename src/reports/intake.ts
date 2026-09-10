import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { DAY } from '../clock';
import { addDays, zonedToUtc, type LocalDate } from '../time';
import type { DiscardReason, ReferralSource } from '../clients/inquiry';

/**
 * Where the practice's clients come from, and where the calls go instead.
 *
 * Counted over *enquiries*, not clients. A referral mix built from client rows
 * only ever shows the calls that worked, which is exactly the number that
 * cannot tell a practice manager anything: "GPs send us most of our clients"
 * and "GPs send us most of our calls and half of them go elsewhere" look
 * identical from the client table and mean opposite things.
 *
 * `Client.referralSource` is the same fact copied at conversion and it is
 * deliberately never reconciled with this one (D-04). This report reads the
 * enquiry, because the enquiry is the only place a non-conversion exists.
 *
 * Aggregates only — no name, no phone, no note. It is guarded on
 * `attendance_history` like every other practice-level number here rather than
 * on `read: inquiry`, because what leaves this function is counts: the report
 * says a source is going cold, never who rang.
 */
export async function referralReport(
  actor: Actor,
  range: { from: LocalDate; to: LocalDate },
) {
  return guarded(
    { actor, action: 'read', resource: 'attendance_history' },
    async (tx) => {
      const rows = await tx.inquiry.findMany({
        where: {
          createdAt: {
            gte: zonedToUtc(range.from, 0),
            lt: zonedToUtc(addDays(range.to, 1), 0),
          },
        },
        select: {
          referralSource: true, status: true, discardReason: true, createdAt: true,
          // The entity behind the two codes (P2). A surgery is the practice's
          // own business relationship, not somebody's health, so naming one on
          // a screen that names no client is still an aggregate.
          referrer: { select: { id: true, practice: true, name: true } },
          referredOutTo: { select: { id: true, practice: true, name: true } },
          client: {
            // How long the call took to become a record, and no further. The
            // tempting next number — call to first session — needs a clinical
            // join this report is structurally not allowed to make (P0-1), and
            // the check that enforces that reads this file as text: naming the
            // model even in a comment fails the build, which is the right
            // sensitivity for an invariant about code nobody has written yet.
            select: { createdAt: true },
          },
        },
      });

      const blank = () => ({ total: 0, open: 0, converted: 0, discarded: 0 });
      const bySource = new Map<string, ReturnType<typeof blank>>();
      const byReason = new Map<string, number>();
      const totals = blank();

      /**
       * Who sends them, and who they were sent to (P2).
       *
       * `gp` referrals with no surgery recorded are simply absent rather than
       * bucketed as "unknown": the honest reading of a null is "nobody wrote it
       * down", and an "unknown" bar large enough to top the table would be a
       * statement about the practice's biggest referrer that is not true.
       */
      type Contact = { id: string; practice: string; name: string | null };
      const label = (r: Contact) => (r.name ? `${r.name}, ${r.practice}` : r.practice);
      const byReferrer = new Map<string, Contact & ReturnType<typeof blank>>();
      const byDestination = new Map<string, Contact & { count: number }>();

      const toConversion: number[] = [];

      for (const r of rows) {
        const row = bySource.get(r.referralSource) ?? blank();
        for (const t of [row, totals]) {
          t.total++;
          if (r.status === 'open') t.open++;
          if (r.status === 'converted') t.converted++;
          if (r.status === 'discarded') t.discarded++;
        }
        bySource.set(r.referralSource, row);

        if (r.status === 'discarded' && r.discardReason) {
          byReason.set(r.discardReason, (byReason.get(r.discardReason) ?? 0) + 1);
        }

        if (r.referrer) {
          const e = byReferrer.get(r.referrer.id) ?? { ...r.referrer, ...blank() };
          e.total++;
          if (r.status === 'open') e.open++;
          if (r.status === 'converted') e.converted++;
          if (r.status === 'discarded') e.discarded++;
          byReferrer.set(r.referrer.id, e);
        }

        if (r.referredOutTo) {
          const e = byDestination.get(r.referredOutTo.id) ?? { ...r.referredOutTo, count: 0 };
          e.count++;
          byDestination.set(r.referredOutTo.id, e);
        }

        if (r.client) {
          toConversion.push((r.client.createdAt.getTime() - r.createdAt.getTime()) / DAY);
        }
      }

      return {
        totals,
        /**
         * A rate per source, so a small source with a good hit rate is visible
         * next to a large one with a bad one. Divided by everything counted,
         * open calls included: an enquiry nobody has rung back has not
         * converted, and hiding it in the denominator would let a growing pile
         * of unreturned calls read as a stable conversion rate.
         */
        sources: [...bySource.entries()]
          .map(([source, s]) => ({
            source: source as ReferralSource,
            ...s,
            conversionRate: s.total === 0 ? 0 : s.converted / s.total,
          }))
          .sort((a, b) => b.total - a.total),
        /**
         * The table the `gp` row could never be. "GPs send us 40% of our calls"
         * is a number nobody can act on; "Riverside sent eleven and nine became
         * clients, Marsh Lane sent nine and one did" is two conversations to
         * have this week.
         */
        referrers: [...byReferrer.values()]
          .map((r) => ({
            id: r.id,
            label: label(r),
            total: r.total,
            open: r.open,
            converted: r.converted,
            discarded: r.discarded,
            conversionRate: r.total === 0 ? 0 : r.converted / r.total,
          }))
          .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
        /** And where the practice sent people instead — the other direction. */
        destinations: [...byDestination.values()]
          .map((r) => ({ id: r.id, label: label(r), count: r.count }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
        reasons: [...byReason.entries()]
          .map(([reason, count]) => ({ reason: reason as DiscardReason, count }))
          .sort((a, b) => b.count - a.count),
        /**
         * Median, not mean. One caller who rang in March and booked in
         * September is a real story about one person and a lie about the
         * practice; the mean tells it and the median does not.
         */
        daysToConversion: median(toConversion),
        conversionRate: totals.total === 0 ? 0 : totals.converted / totals.total,
      };
    },
  );
}

/** Null for an empty sample — a median of no numbers is not zero. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
