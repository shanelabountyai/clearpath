import { headers } from 'next/headers';
import type { Action, Resource } from './auth/permissions';
import { claimTokenDoor } from './token-door';

/**
 * Whoever the proxy says is asking.
 *
 * Spoofable — `x-forwarded-for` is a header, and a determined attacker rotates
 * it — which is why it is a hash key for a spam ceiling and never an identity.
 * Falling back to one shared bucket is the safe direction: an unattributable
 * request is throttled alongside every other unattributable request rather than
 * escaping the limit entirely.
 */
export async function requestAddress(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || h.get('x-real-ip') || 'unknown';
}

/** One request through a capability-token door from this address (K5); false = refused. */
export async function passTokenDoor(door: { action: Action; resource: Resource }): Promise<boolean> {
  return claimTokenDoor(await requestAddress(), door);
}
