import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SubscriptionTier } from 'onehook-api-client';
import { HANDOVER_DETAIL_TYPE, HANDOVER_SOURCE, ProHandoverWorker, parseHandoverMessage } from '../proHandoverWorker';
import { ProStore } from '../proStore';
import { ProSubscriptionService, SUBSCRIPTION_ROW, parseSubscription } from '../proSubscriptionService';
import { FakeProPaymentProvider } from '../proPayments';
import { MembershipUnavailableError } from '../membershipDirectory';
import type { ErasureQueue, QueueMessage } from '../uxErasureWorker';
import { MemoryProTable } from './helpers/memoryProTable';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const event = (detail: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
  id: 'evt-1', source: HANDOVER_SOURCE, 'detail-type': HANDOVER_DETAIL_TYPE, detail, ...extra,
});

test('handover events are parsed strictly; others are not ours; broken ones are malformed', () => {
  assert.deepEqual(parseHandoverMessage(event({ userId: 'u1', activationId: 'a1' })), { kind: 'handover', eventId: 'evt-1', userId: 'u1', activationId: 'a1' });
  assert.deepEqual(parseHandoverMessage(event({ userId: 'u1' }, { 'detail-type': 'UserDeleted' })), { kind: 'not-ours' });
  assert.equal(parseHandoverMessage('not json').kind, 'malformed');
  assert.equal(parseHandoverMessage(event({ userId: 'u 1', activationId: 'a1' })).kind, 'malformed');
  assert.equal(parseHandoverMessage(event({ activationId: 'a1' })).kind, 'malformed');
});

function harness(stateDown: () => boolean) {
  const confirmed: string[] = [];
  const store = new ProStore(new MemoryProTable());
  const pro = new ProSubscriptionService({
    store, provider: new FakeProPaymentProvider(),
    prices: { MONTHLY: 79_900, YEARLY: 599_900 }, currency: 'INR', logger: quiet,
    directory: {
      get: async () => ({ tier: SubscriptionTier.INFINITY }),
      confirmProHandover: async (_u, activationId) => {
        if (stateDown()) throw new MembershipUnavailableError('down');
        confirmed.push(activationId);
      },
    },
  });
  const deleted: string[] = [];
  const released: string[] = [];
  const pending: QueueMessage[] = [];
  const queue: ErasureQueue = {
    receive: async () => pending.splice(0),
    delete: async (h) => { deleted.push(h); },
    release: async (h) => { released.push(h); },
  };
  return { store, pro, confirmed, deleted, released, pending, worker: new ProHandoverWorker(queue, pro, quiet) };
}

test('the worker settles the subscription and confirms before acknowledging; a failure leaves the message', async () => {
  let down = true;
  const h = harness(() => down);
  await h.pro.purchase('u1', SubscriptionTier.SUPER, { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' }, randomUUID());
  const message = { messageId: 'm1', receiptHandle: 'r1', body: event({ userId: 'u1', activationId: 'a1' }), receiveCount: 1 };
  assert.equal(await h.worker.handle(message), 'failed', 'State unreachable: not confirmed, not acknowledged');
  assert.deepEqual([h.deleted, h.confirmed], [[], []]);
  down = false;
  assert.equal(await h.worker.handle({ ...message, receiveCount: 2 }), 'settled');
  assert.deepEqual([h.deleted, h.confirmed], [['r1'], ['a1']]);
  const sub = (await h.store.read('u1', SUBSCRIPTION_ROW, parseSubscription))!.value;
  assert.deepEqual([sub.pausedForMembership, sub.autoRenew], [true, false]);
  assert.equal(await h.worker.handle({ ...message, receiptHandle: 'r2', receiveCount: 3 }), 'duplicate', 'redelivery confirms again');
  assert.deepEqual(h.confirmed, ['a1', 'a1']);
  // Malformed: released for the DLQ, never acknowledged. Not ours: acknowledged, nothing touched.
  assert.equal(await h.worker.handle({ messageId: 'm2', receiptHandle: 'r3', body: '{', receiveCount: 1 }), 'malformed');
  assert.deepEqual(h.released, ['r3']);
  assert.equal(await h.worker.handle({ messageId: 'm3', receiptHandle: 'r4', body: event({}, { source: 'club.onehook.profile' }), receiveCount: 1 }), 'not-ours');
  assert.ok(h.deleted.includes('r4'));
});
