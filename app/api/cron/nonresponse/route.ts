import { systemClock } from '@/src/clock';
import { cronAuthorized, nonResponseRun } from '@/src/jobs';

export const dynamic = 'force-dynamic';

/** Vercel Cron's door to `npm run nonresponse:run`. The schedule is in vercel.json. */
export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get('authorization'))) return new Response(null, { status: 401 });
  return Response.json(await nonResponseRun(systemClock));
}
