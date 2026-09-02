import { buildSuperbill, superbillCsv } from '../../../../../src/billing/superbill';
import { requireSession } from '../../../../../src/session';
import { systemClock } from '@/src/clock';
import { localDateOf } from '@/src/time';

export const dynamic = 'force-dynamic';

/**
 * The client's superbill for a date range, as CSV.
 *
 * No role check here: `buildSuperbill` is guarded on both the fee and the
 * demographics, so this route is a formatter and the matrix is the door.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { actor } = await requireSession();
  const { id } = await params;
  const p = new URL(request.url).searchParams;

  const today = localDateOf(systemClock.now());
  const from = p.get('from') || `${today.slice(0, 4)}-01-01`;
  const to = p.get('to') || today;

  const bill = await buildSuperbill(actor, id, { from, to });

  return new Response(superbillCsv(bill), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      // The client's code, not their name: a filename lands in a downloads
      // folder, an email subject, and a screen share.
      'content-disposition': `attachment; filename="superbill-${bill.client.code}-${from}-to-${to}.csv"`,
    },
  });
}
