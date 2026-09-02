import { queryAuditLog, toCsv } from '../../../../src/reports/audit';
import { requireSession } from '../../../../src/session';
import { systemClock } from '@/src/clock';

export const dynamic = 'force-dynamic';

/** CSV export. Guarded by the same query the screen uses, so no second door. */
export async function GET(request: Request) {
  const { actor } = await requireSession();
  const p = new URL(request.url).searchParams;

  const { rows } = await queryAuditLog(actor, {
    clientId: p.get('clientId') || undefined,
    actorId: p.get('actorId') || undefined,
    resource: p.get('resource') || undefined,
    flaggedOnly: p.get('flagged') === '1',
    deniedOnly: p.get('denied') === '1',
    limit: 1000,
  });

  return new Response(toCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="clearpath-audit-${systemClock.now().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
