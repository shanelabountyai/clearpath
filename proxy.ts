// The demo gate (SEC-01), in front of every route. Named proxy.ts because Next
// 16 renamed the middleware convention.
import { NextResponse, type NextRequest } from 'next/server';
import { demoChallenge } from './src/demo-gate';

export function proxy(request: NextRequest): NextResponse {
  const challenge = demoChallenge(
    request.nextUrl.pathname,
    request.headers.get('authorization'),
    process.env.DEMO_ACCESS_PASSWORD,
    process.env.NODE_ENV === 'production',
  );
  if (!challenge) return NextResponse.next();
  return new NextResponse(challenge.status === 503 ? 'Demo is not configured.' : 'Demo access required.', {
    status: challenge.status,
    headers: challenge.headers,
  });
}

// Static assets and the image optimiser carry no data, and challenging them
// makes a gated page render without its stylesheet.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
