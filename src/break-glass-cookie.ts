import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HOUR } from './clock';
import { isBreakGlassReason } from './break-glass-reasons';

/**
 * The break-glass state is a cookie, so anyone can set one by hand. Signing it
 * (SEC-03) means the only way to hold a valid one is to have gone through
 * `startBreakGlass`, which is what writes the "break-glass opened" audit row.
 * The MAC covers the user id, the reason code and the issue time, so a cookie
 * minted for one person is worthless on another's session, and one minted
 * yesterday is worthless today (review #2).
 *
 * Unset in production it throws, the same shape as `CLEARPATH_THROTTLE_SECRET`:
 * a per-process key would sign cookies the next instance cannot verify.
 */
const DEV_FALLBACK_SECRET = randomBytes(32).toString('hex');

/** An emergency is short. Past this the person breaks glass again, and that is logged again. */
export const BREAK_GLASS_TTL = HOUR;

function secret(env: NodeJS.ProcessEnv): string {
  if (env.CLEARPATH_SESSION_SECRET) return env.CLEARPATH_SESSION_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new Error('CLEARPATH_SESSION_SECRET is not set: break-glass cookies cannot be signed or verified');
  }
  return DEV_FALLBACK_SECRET;
}

const mac = (userId: string, reason: string, issuedAt: string, env: NodeJS.ProcessEnv) =>
  createHmac('sha256', secret(env)).update(`${userId}\n${reason}\n${issuedAt}`).digest();

export function signBreakGlass(userId: string, reason: string, issuedAt: Date, env: NodeJS.ProcessEnv = process.env): string {
  if (!isBreakGlassReason(reason)) throw new Error('break-glass takes a reason code, not free text');
  const iat = String(issuedAt.getTime());
  return `${reason}.${iat}.${mac(userId, reason, iat, env).toString('base64url')}`;
}

/** The reason code if the cookie is genuine for this user and unexpired, otherwise null. */
export function verifyBreakGlass(
  userId: string,
  value: string,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const [reason, iat, encodedMac, ...extra] = value.split('.');
  if (reason === undefined || iat === undefined || encodedMac === undefined || extra.length > 0) return null;
  const given = Buffer.from(encodedMac, 'base64url');
  const expected = mac(userId, reason, iat, env);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!isBreakGlassReason(reason)) return null;
  return now.getTime() - Number(iat) <= BREAK_GLASS_TTL ? reason : null;
}
