// One shared password over the whole site, HTTP Basic (SEC-01).
//
// Not access control — the identity picker still lets anyone who is past the
// gate become anyone. It keeps a public demo URL from being found, browsed and
// written to by strangers, on a database that holds a counseling practice's
// records (synthetic, and it must stay that way).
//
// Unset locally and in unit tests = no gate. Unset in PRODUCTION = fail closed
// (503, no challenge): a deployment that forgot the variable must not be
// quietly public. The e2e sweep is a production build, so it sets a throwaway
// password and sends it, rather than opting out.
//
// ponytail: one password for everyone, no per-viewer identity. Upgrade is real
// accounts, which is what src/session.ts is the seam for.

/** Carries its own bearer check (`cronAuthorized`); Basic in front would break Vercel Cron. */
const EXEMPT_PREFIX = '/api/cron/';

/** Length-checked constant-time compare. Edge-safe: no Node APIs. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

/**
 * Returns the response to send, or null to let the request through.
 *
 * `password` and `production` are passed in so the decision is pure — nothing
 * in this file reads process.env.
 */
export function demoChallenge(
  pathname: string,
  authorization: string | null,
  password: string | undefined,
  production: boolean,
): { status: number; headers: Record<string, string> } | null {
  if (pathname.startsWith(EXEMPT_PREFIX)) return null;

  if (!password) {
    return production ? { status: 503, headers: HEADERS } : null;
  }

  const [scheme, encoded] = (authorization ?? '').split(' ');
  if (scheme?.toLowerCase() === 'basic' && encoded) {
    let decoded = '';
    try {
      decoded = atob(encoded);
    } catch {
      decoded = '';
    }
    // "user:pass" — the username is ignored, the password is the whole check.
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    if (decoded.includes(':') && safeEqual(supplied, password)) return null;
  }

  return {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Clearpath demo", charset="UTF-8"', ...HEADERS },
  };
}
