import { auditEvent } from './auth/guard';
import type { Action, Resource } from './auth/permissions';
import { systemClock, type Clock } from './clock';
import { claimSlot, PUBLIC_ACTOR, submitterKey } from './clients/public-inquiry';

/**
 * The per-address ceiling on the capability-token doors, /f and /p (K5).
 *
 * The tokens are 192-bit, so this is not what stops a guess landing; it is what
 * stops a scanner from walking the doors without limit, writing one
 * `refused:unknown_token` audit row per try. Every request through a door counts
 * — page loads, saves, answers — because a scanner's misses and a client's hits
 * look the same until the lookup has already run.
 *
 * Generous on purpose. A client opens their link, saves a form a few times, and
 * taps an answer or two: a handful of requests. 300 an hour is a household on
 * one NAT address doing that many times over, and still a ceiling a script hits
 * in seconds.
 *
 * The same table and the same atomic claim as the public enquiry form, under its
 * own key prefix so the two allowances never share a count. Spent windows are
 * swept by the same purge (`runInquiryPurge`).
 */
export const TOKEN_DOOR_PER_HOUR = 300;

export const tokenDoorKey = (address: string, env: NodeJS.ProcessEnv = process.env) =>
  `door:${submitterKey(address, env)}`;

/**
 * Claim one request through a token door, or refuse it on the record.
 *
 * A refusal is a denial, so it is audited (hard rule 4), as the public actor and
 * by reason code only — never the token, never the address.
 */
export async function claimTokenDoor(
  address: string,
  door: { action: Action; resource: Resource },
  clock: Clock = systemClock,
): Promise<boolean> {
  if (await claimSlot(tokenDoorKey(address), TOKEN_DOOR_PER_HOUR, clock)) return true;
  await auditEvent(PUBLIC_ACTOR, door.action, door.resource, {
    rule: 'token', reason: 'refused:throttled', allowed: false,
  });
  return false;
}
