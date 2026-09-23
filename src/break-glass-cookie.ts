import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The break-glass state is a cookie, so anyone can set one by hand. Signing it
 * (SEC-03) means the only way to hold a valid one is to have gone through
 * `startBreakGlass`, which is what writes the "break-glass opened" audit row.
 * The MAC covers the user id as well as the reason, so a cookie minted for one
 * person is worthless on another's session.
 *
 * Unset in production it throws, the same shape as `CLEARPATH_THROTTLE_SECRET`:
 * a per-process key would sign cookies the next instance cannot verify.
 */
const DEV_FALLBACK_SECRET = randomBytes(32).toString('hex');

function secret(env: NodeJS.ProcessEnv): string {
  if (env.CLEARPATH_SESSION_SECRET) return env.CLEARPATH_SESSION_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new Error('CLEARPATH_SESSION_SECRET is not set: break-glass cookies cannot be signed or verified');
  }
  return DEV_FALLBACK_SECRET;
}

const mac = (userId: string, reason: string, env: NodeJS.ProcessEnv) =>
  createHmac('sha256', secret(env)).update(`${userId}\n${reason}`).digest();

export function signBreakGlass(userId: string, reason: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${Buffer.from(reason).toString('base64url')}.${mac(userId, reason, env).toString('base64url')}`;
}

/** The reason if the cookie is genuine for this user, otherwise null. */
export function verifyBreakGlass(
  userId: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const [encodedReason, encodedMac, ...extra] = value.split('.');
  if (encodedReason === undefined || encodedMac === undefined || extra.length > 0) return null;
  const reason = Buffer.from(encodedReason, 'base64url').toString();
  const given = Buffer.from(encodedMac, 'base64url');
  const expected = mac(userId, reason, env);
  return given.length === expected.length && timingSafeEqual(given, expected) ? reason : null;
}
