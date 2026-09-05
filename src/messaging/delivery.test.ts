import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, HOUR } from '../clock';
import { prisma } from '../db';
import { makeClient, makeUser, resetDb, settings } from '../test/harness';
import {
  simulatedCarrier,
  type Carrier,
  type CarrierAck,
  type DeliveryFailure,
} from './carrier';
import { dispatchOutbox, recordReceipt, runCarrier, settleSimulated } from './delivery';
import { queueToClient } from './outbox';

const NOW = new Date('2026-09-01T12:00:00Z');
const clock = fixedClock(NOW);
const at = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  await settings({ messagingName: 'Stillwater' });
});
afterAll(() => prisma.$disconnect());

/** A carrier that always says the same thing, so a spec can name the case it means. */
const scripted = (ack: CarrierAck): Carrier => ({ name: 'scripted', send: async () => ack });
const accepts = (ref = 'ref-1') => scripted({ providerRef: ref, accepted: true });
const refuses = (failureCode: DeliveryFailure, ref = 'ref-1') =>
  scripted({ providerRef: ref, accepted: false, failureCode });

async function queued(over: { email?: string | null; phone?: string | null; preference?: 'email' | 'sms' } = {}) {
  const clinician = await makeUser('therapist');
  const client = await makeClient(clinician.id);
  await prisma.client.update({
    where: { id: client.id },
    data: {
      email: over.email === undefined ? 'tc-001@example.test' : over.email,
      phone: over.phone === undefined ? '555-010-0199' : over.phone,
      reminderPreference: over.preference ?? 'email',
    },
  });
  const message = await queueToClient({
    clientId: client.id,
    templateKey: 'appointment_reminder',
    scheduledFor: NOW,
    startAt: at(5 * 24 * HOUR),
    link: 'http://localhost:3700/p/abc',
  });
  return { clinician, client, message: message! };
}

const reload = (id: string) => prisma.outboxMessage.findUniqueOrThrow({ where: { id } });

describe('dispatchOutbox — the practice hands a message over', () => {
  it('starts every queued message at `queued` with nothing spent', async () => {
    const { message } = await queued();
    expect(message.deliveryState).toBe('queued');
    expect(message.attempts).toBe(0);
    expect(message.sentAt).toBeNull();
  });

  /**
   * `sent` is the old precondition wearing a better name: a carrier took it.
   * Nothing about this row is allowed to end in a fee.
   */
  it('records acceptance as `sent`, not as delivered', async () => {
    const { message } = await queued();
    const result = await dispatchOutbox({ clock, carrier: accepts() });

    expect(result.sent).toEqual([message.id]);
    const row = await reload(message.id);
    expect(row.deliveryState).toBe('sent');
    expect(row.attempts).toBe(1);
    expect(row.providerRef).toBe('ref-1');
    expect(row.carrier).toBe('scripted');
    expect(row.sentAt).toEqual(NOW);
    expect(row.deliveredAt).toBeNull();
  });

  it('leaves a receipt for the acceptance, because that too is the carrier speaking', async () => {
    const { message } = await queued();
    await dispatchOutbox({ clock, carrier: accepts() });

    const receipts = await prisma.deliveryReceipt.findMany({ where: { outboxMessageId: message.id } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ state: 'sent', attempt: 1, ignored: false, providerRef: 'ref-1' });
  });

  it('does not dispatch a message before it is scheduled', async () => {
    const { message } = await queued();
    await prisma.outboxMessage.update({ where: { id: message.id }, data: { scheduledFor: at(HOUR) } });
    expect((await dispatchOutbox({ clock, carrier: accepts() })).sent).toEqual([]);
  });

  it('is idempotent: a second run finds nothing to hand over', async () => {
    await queued();
    expect((await dispatchOutbox({ clock, carrier: accepts() })).sent).toHaveLength(1);
    expect((await dispatchOutbox({ clock, carrier: accepts() })).sent).toHaveLength(0);
  });

  it('fails permanently on an address that could not reach anybody', async () => {
    const { message } = await queued({ email: 'not-an-address' });
    const result = await dispatchOutbox({ clock, carrier: simulatedCarrier() });

    expect(result.rejected).toEqual([message.id]);
    const row = await reload(message.id);
    expect(row).toMatchObject({ deliveryState: 'failed', failureCode: 'invalid_destination', sentAt: null });
    expect(row.nextAttemptAt).toBeNull();
  });

  it('sends the sms channel to the phone and the email channel to the address', async () => {
    const { message } = await queued({ preference: 'sms', email: null });
    let seen = '';
    await dispatchOutbox({
      clock,
      carrier: { name: 'spy', send: async (m) => { seen = m.to; return { providerRef: 'r', accepted: true }; } },
    });
    expect(seen).toBe('555-010-0199');
    expect((await reload(message.id)).deliveryState).toBe('sent');
  });

  /** A transient refusal at the door gets the same retry the callback path has. */
  it('requeues a transient refusal with a backoff time on it', async () => {
    const { message } = await queued();
    const result = await dispatchOutbox({ clock, carrier: refuses('carrier_unavailable') });

    expect(result.retrying).toEqual([message.id]);
    const row = await reload(message.id);
    expect(row.deliveryState).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toEqual(at(15 * 60_000));
  });

  it('holds a requeued message until its backoff has passed, then tries again', async () => {
    await queued();
    await dispatchOutbox({ clock, carrier: refuses('carrier_unavailable') });

    clock.set(at(10 * 60_000));
    expect((await dispatchOutbox({ clock, carrier: accepts() })).sent).toHaveLength(0);

    clock.set(at(20 * 60_000));
    expect((await dispatchOutbox({ clock, carrier: accepts() })).sent).toHaveLength(1);
  });

  it('gives up once the attempts are spent', async () => {
    const { message } = await queued();
    for (const minutes of [0, 20, 50, 130]) {
      clock.set(at(minutes * 60_000));
      await dispatchOutbox({ clock, carrier: refuses('carrier_unavailable') });
    }
    const row = await reload(message.id);
    expect(row.deliveryState).toBe('failed');
    expect(row.failureCode).toBe('carrier_unavailable');
  });

  /**
   * Ours, not the carrier's — so it gets no receipt row. "They did not get it"
   * and "we gave up" are different sentences in a defence of a fee.
   */
  it('abandons a message whose hour has already started, with no receipt', async () => {
    const { message } = await queued();
    clock.set(at(6 * 24 * HOUR));

    const result = await dispatchOutbox({ clock, carrier: accepts() });
    expect(result.expired).toEqual([message.id]);

    const row = await reload(message.id);
    expect(row).toMatchObject({ deliveryState: 'failed', failureCode: 'expired' });
    expect(await prisma.deliveryReceipt.count({ where: { outboxMessageId: message.id } })).toBe(0);
  });

  it('reaches a clinician-directed row through its bare userId', async () => {
    const clinician = await makeUser('therapist');
    await prisma.outboxMessage.create({
      data: {
        userId: clinician.id, channel: 'email', templateKey: 'alert',
        subject: 'An alert', body: 'reason codes only', scheduledFor: NOW,
      },
    });
    let seen = '';
    await dispatchOutbox({
      clock,
      carrier: { name: 'spy', send: async (m) => { seen = m.to; return { providerRef: 'r', accepted: true }; } },
    });
    expect(seen).toBe(clinician.email);
  });
});

describe('recordReceipt — the only path to `delivered`', () => {
  it('marks a message delivered and stamps when the carrier says it arrived', async () => {
    const { message } = await queued();
    await dispatchOutbox({ clock, carrier: accepts() });

    const result = await recordReceipt({ providerRef: 'ref-1', state: 'delivered', occurredAt: at(HOUR) });
    expect(result).toMatchObject({ outboxMessageId: message.id, state: 'delivered', applied: true });

    const row = await reload(message.id);
    expect(row.deliveryState).toBe('delivered');
    expect(row.deliveredAt).toEqual(at(HOUR));
  });

  it('records a permanent failure reported after acceptance', async () => {
    const { message } = await queued();
    await dispatchOutbox({ clock, carrier: accepts() });
    await recordReceipt({ providerRef: 'ref-1', state: 'failed', failureCode: 'unreachable', occurredAt: at(HOUR) });

    expect(await reload(message.id)).toMatchObject({ deliveryState: 'failed', failureCode: 'unreachable' });
  });

  /**
   * Carriers replay callbacks after an outage. A 500 here would make the
   * provider retry a message this practice no longer has.
   */
  it('returns null for a reference it does not know, rather than throwing', async () => {
    expect(await recordReceipt({ providerRef: 'never-issued', state: 'delivered', occurredAt: NOW })).toBeNull();
  });

  it('keeps a receipt it ignored, and changes nothing', async () => {
    const { message } = await queued();
    await dispatchOutbox({ clock, carrier: accepts() });
    await recordReceipt({ providerRef: 'ref-1', state: 'delivered', occurredAt: at(2 * HOUR) });

    const stale = await recordReceipt({
      providerRef: 'ref-1', state: 'failed', failureCode: 'unreachable', occurredAt: at(HOUR),
    });
    expect(stale).toMatchObject({ applied: false, state: 'delivered' });
    expect((await reload(message.id)).deliveryState).toBe('delivered');

    const receipts = await prisma.deliveryReceipt.findMany({
      where: { outboxMessageId: message.id }, orderBy: { occurredAt: 'asc' },
    });
    expect(receipts.map((r) => [r.state, r.ignored])).toEqual([
      ['sent', false], ['failed', true], ['delivered', false],
    ]);
  });

  it('is safe to replay: the same receipt twice leaves one state and two rows', async () => {
    const { message } = await queued();
    await dispatchOutbox({ clock, carrier: accepts() });
    await recordReceipt({ providerRef: 'ref-1', state: 'delivered', occurredAt: at(HOUR) });
    const again = await recordReceipt({ providerRef: 'ref-1', state: 'delivered', occurredAt: at(HOUR) });

    expect(again?.applied).toBe(false);
    expect((await reload(message.id)).deliveryState).toBe('delivered');
    expect(await prisma.deliveryReceipt.count({ where: { outboxMessageId: message.id } })).toBe(3);
  });

  /**
   * A callback for attempt one arriving after attempt two has begun still finds
   * its message: the superseded reference is on a receipt row that is still here.
   */
  it('matches a reference from a superseded attempt', async () => {
    const { message } = await queued();
    await dispatchOutbox({ clock, carrier: refuses('carrier_unavailable', 'ref-old') });
    clock.set(at(HOUR));
    await dispatchOutbox({ clock, carrier: accepts('ref-new') });

    const late = await recordReceipt({ providerRef: 'ref-old', state: 'delivered', occurredAt: at(2 * HOUR) });
    expect(late?.outboxMessageId).toBe(message.id);
  });

  it('clears deliveredAt if a later receipt retracts the delivery', async () => {
    const { message } = await queued();
    await dispatchOutbox({ clock, carrier: accepts() });
    await recordReceipt({ providerRef: 'ref-1', state: 'delivered', occurredAt: at(HOUR) });
    await recordReceipt({
      providerRef: 'ref-1', state: 'failed', failureCode: 'unreachable', occurredAt: at(2 * HOUR),
    });

    const row = await reload(message.id);
    expect(row.deliveryState).toBe('failed');
    expect(row.deliveredAt).toBeNull();
  });
});

describe('settleSimulated — the webhook that never arrives', () => {
  it('settles nothing until the provider lag has passed', async () => {
    await queued();
    await dispatchOutbox({ clock, carrier: simulatedCarrier() });

    clock.set(at(5 * 60_000));
    expect(await settleSimulated({ clock })).toHaveLength(0);

    clock.set(at(20 * 60_000));
    expect(await settleSimulated({ clock })).toHaveLength(1);
  });

  it('drives a message all the way to delivered through both halves', async () => {
    const { message } = await queued();
    await runCarrier({ clock });
    clock.set(at(HOUR));
    await runCarrier({ clock });

    const row = await reload(message.id);
    expect(row.deliveryState).toBe('delivered');
    expect(row.deliveredAt).toEqual(at(HOUR));
  });

  it('never settles a message the carrier refused at the door', async () => {
    const { message } = await queued({ email: 'not-an-address' });
    await runCarrier({ clock });
    clock.set(at(HOUR));
    await runCarrier({ clock });

    expect((await reload(message.id)).deliveryState).toBe('failed');
  });
});
