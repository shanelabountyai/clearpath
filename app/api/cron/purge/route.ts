import { systemClock } from '@/src/clock';
import { cronAuthorized, purgeRun } from '@/src/jobs';

export const dynamic = 'force-dynamic';

/** Vercel Cron's door to `npm run purge:run`. The schedule is in vercel.json. */
export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get('authorization'))) return new Response(null, { status: 401 });
  return Response.json(await purgeRun(systemClock));
}
