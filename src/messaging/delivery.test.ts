import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import { prisma } from '../db';
import { NotFound } from '../errors';
import { makeClient, makeUser, resetDb, settings } from '../test/harness';
import { dispatchOutbox, recordDeliveryReceipt } from './delivery';
import { queueToClient } from './outbox';

const NOON = fixedClock('2026-09-01T16:00:00Z');
const LATER = fixedClock('2026-09-01T16:05:00Z');

let clientId: string;

/** A message due at `scheduledFor`, straight from the real queue path. */
async function queued(scheduledFor = new Date('2026-09-01T15:00:00Z')) {
  const message = await queueToClient({
    clientId, templateKey: 'appointment_reminder', scheduledFor,
    startAt: new Date('2026-09-01T19:00:00Z'), link: 'http://localhost:3700/p/abc',
  });
  return message!;
}

const reload = (id: string) => prisma.outboxMessage.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetDb();
  await settings({ messagingName: 'Stillwater' });
  const therapist = await makeUser('therapist');
  const client = await makeClient(therapist.id);
  clientId = (await prisma.client.update({
    where: { id: client.id },
    data: { email: 'tc@example.test', reminderPreference: 'email' },
  })).id;
});
afterAll(() => prisma.$disconnect());

describe('dispatch', () => {
  it('hands over what is due and leaves the rest queued', async () => {
    const due = await queued();
    const later = await queued(new Date('2026-09-02T15:00:00Z'));

    expect(await dispatchOutbox(NOON)).toEqual([due.id]);
    expect((await reload(due.id)).deliveryState).toBe('sent');
    expect((await reload(due.id)).sentAt).toEqual(NOON.now());
    expect((await reload(later.id)).deliveryState).toBe('queued');
  });

  it('is idempotent — a second run has nothing to hand over', async () => {
    await queued();

    expect(await dispatchOutbox(NOON)).toHaveLength(1);
    expect(await dispatchOutbox(NOON)).toEqual([]);
  });

  it('does not re-send a message a receipt has already settled', async () => {
    const message = await queued();
    await dispatchOutbox(NOON);
    await recordDeliveryReceipt(message.id, 'delivered', LATER);

    expect(await dispatchOutbox(LATER)).toEqual([]);
    expect((await reload(message.id)).deliveryState).toBe('delivered');
  });
});

describe('receipts', () => {
  it('records an arrival, with the moment it arrived', async () => {
    const message = await queued();
    await dispatchOutbox(NOON);

    expect(await recordDeliveryReceipt(message.id, 'delivered', LATER)).toBe(true);
    const after = await reload(message.id);
    expect(after.deliveryState).toBe('delivered');
    expect(after.deliveredAt).toEqual(LATER.now());
    expect(after.failureCode).toBeNull();
  });

  it('records a failure as a code, and leaves no arrival behind it', async () => {
    const message = await queued();

    expect(await recordDeliveryReceipt(message.id, 'failed', LATER, 'unreachable')).toBe(true);
    const after = await reload(message.id);
    expect(after.deliveryState).toBe('failed');
    expect(after.failureCode).toBe('unreachable');
    expect(after.deliveredAt).toBeNull();
  });

  it('defaults a failure with no code to `unknown` rather than to nothing', async () => {
    const message = await queued();
    await recordDeliveryReceipt(message.id, 'failed', LATER);

    expect((await reload(message.id)).failureCode).toBe('unknown');
  });

  /**
   * A carrier that retracts a `delivered` is retracting evidence a fee may
   * already rest on. The first receipt stands and a human can look at the
   * dispute; a webhook is not allowed to un-charge somebody quietly.
   */
  it('will not move out of a terminal state, in either direction', async () => {
    const delivered = await queued();
    const failed = await queued();
    await recordDeliveryReceipt(delivered.id, 'delivered', LATER);
    await recordDeliveryReceipt(failed.id, 'failed', LATER);

    expect(await recordDeliveryReceipt(delivered.id, 'failed', LATER)).toBe(false);
    expect(await recordDeliveryReceipt(failed.id, 'delivered', LATER)).toBe(false);
    expect((await reload(delivered.id)).deliveryState).toBe('delivered');
    expect((await reload(failed.id)).deliveryState).toBe('failed');
  });

  it('is a no-op on a duplicate webhook rather than an error', async () => {
    const message = await queued();

    expect(await recordDeliveryReceipt(message.id, 'delivered', LATER)).toBe(true);
    expect(await recordDeliveryReceipt(message.id, 'delivered', LATER)).toBe(false);
  });

  it('refuses an id it has never seen — an unknown message is not a settled one', async () => {
    await expect(recordDeliveryReceipt('nope', 'delivered', LATER)).rejects.toBeInstanceOf(NotFound);
  });

  /**
   * The column is read by roles that may not open a record, so it carries the
   * same rule as the inbound classifier: codes, never words.
   */
  it('keeps no client-facing text in the failure column', async () => {
    const message = await queued();
    await recordDeliveryReceipt(message.id, 'failed', LATER, 'carrier_rejected');

    const code = (await reload(message.id)).failureCode!;
    expect(code).toMatch(/^[a-z_]+$/);
    expect(code).not.toContain(' ');
  });
});
