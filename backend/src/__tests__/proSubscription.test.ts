import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SubscriptionTier } from 'onehook-api-client';
import { ProStore } from '../proStore';
import {
  addMonths,
  CONTINUATION_ROW,
  ProRequestError,
  ProRetryLaterError,
  ProSubscriptionService,
  SUBSCRIPTION_ROW,
  parseContinuation,
  parseSubscription,
  yearlyRefund,
} from '../proSubscriptionService';
import { FakeProPaymentProvider, FAKE_TOKENS } from '../proPayments';
import { MembershipUnavailableError, type MembershipSnapshot } from '../membershipDirectory';
import { MemoryProTable, manualClock } from './helpers/memoryProTable';

/**
 * Mr OneHook Pro money rules, on a clock the test moves. The fake provider records every charge and
 * refund, so each case asserts exactly what a member would have paid.
 */
const { SUPER, INFINITY } = SubscriptionTier;
const DAY = 86_400_000;
const START = '2026-01-10T09:00:00.000Z';

function setup(start = START) {
  const clock = manualClock(start);
  const table = new MemoryProTable();
  const store = new ProStore(table);
  const provider = new FakeProPaymentProvider();
  const state = new Map<string, MembershipSnapshot>();
  const confirmed: string[] = [];
  let stateDown = false;
  const directory = {
    get: async (userId: string): Promise<MembershipSnapshot> => {
      if (stateDown) throw new MembershipUnavailableError('down');
      return state.get(userId) ?? { tier: SUPER };
    },
    confirmProHandover: async (_u: string, activationId: string) => {
      if (stateDown) throw new MembershipUnavailableError('down');
      confirmed.push(activationId);
    },
  };
  const service = new ProSubscriptionService({
    store, provider, directory, prices: { MONTHLY: 79_900, YEARLY: 599_900 }, currency: 'INR',
    now: clock.now, logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const sub = async (userId = 'm1') => (await store.read(userId, SUBSCRIPTION_ROW, parseSubscription))?.value;
  const cont = async (userId = 'm1') => (await store.read(userId, CONTINUATION_ROW, parseContinuation))?.value;
  const kinds = async (userId = 'm1') => (await service.memberState(userId, SUPER)).notices.map((n) => n.kind).sort();
  return {
    clock, table, store, provider, state, confirmed, service, sub, cont, kinds,
    setStateDown: (down: boolean) => { stateDown = down; },
    charged: () => provider.succeededCharges().map((c) => `${c.kind}:${c.amountMinor}`),
  };
}

const rejectsWith = (status: number, code: string) => (error: unknown) =>
  error instanceof ProRequestError && error.status === status && error.code === code;

test('date math: months clamp to the last day; the yearly refund keeps the month in progress', () => {
  assert.equal(addMonths('2026-01-31T10:00:00.000Z', 1), '2026-02-28T10:00:00.000Z');
  assert.equal(addMonths('2028-01-31T10:00:00.000Z', 1), '2028-02-29T10:00:00.000Z');
  assert.equal(addMonths('2026-01-10T09:00:00.000Z', 12), '2027-01-10T09:00:00.000Z');
  // 3 months and 5 days into a yearly plan: month 4 is in progress and kept; 8 months come back.
  assert.deepEqual(yearlyRefund(START, 599_900, '2026-04-15T00:00:00.000Z'), { dueAt: '2026-05-10T09:00:00.000Z', amountMinor: 399_933 });
  // In the 12th month nothing is left to refund.
  assert.equal(yearlyRefund(START, 599_900, '2026-12-20T00:00:00.000Z').amountMinor, 0);
});

test('purchase: one charge, idempotent per key; a second purchase is refused', async () => {
  const t = setup();
  const key = randomUUID();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, key);
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, key);
  await assert.rejects(t.service.purchase('m1', SUPER, { billingPeriod: 'YEARLY' }, randomUUID()), rejectsWith(409, 'PRO_ALREADY_ACTIVE'));
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
  const s = await t.sub();
  assert.deepEqual([s!.status, s!.currentPeriodEnd], ['ACTIVE', '2026-02-10T09:00:00.000Z']);
  assert.deepEqual(await t.service.entitlement('m1', SUPER), { plan: 'PRO', source: 'SUBSCRIPTION' });
  assert.deepEqual(await t.kinds(), ['PRO_PURCHASED']);
});

test('a member whose membership includes Pro is never charged and cannot buy', async () => {
  const t = setup();
  await assert.rejects(t.service.purchase('m1', INFINITY, { billingPeriod: 'YEARLY' }, randomUUID()), rejectsWith(409, 'PRO_INCLUDED_IN_MEMBERSHIP'));
  assert.deepEqual(t.provider.charges, []);
  assert.deepEqual(await t.service.entitlement('m1', INFINITY), { plan: 'PRO', source: 'MEMBERSHIP' });
  assert.equal((await t.service.memberState('m1', INFINITY)).canPurchase, false);
});

test('right after a handover a stale token cannot buy Pro: State is asked', async () => {
  const t = setup();
  await t.service.handleHandover('m1', 'act-1', 'evt-1');
  t.state.set('m1', { tier: INFINITY });
  await assert.rejects(t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY' }, randomUUID()), rejectsWith(409, 'PRO_INCLUDED_IN_MEMBERSHIP'));
  t.setStateDown(true);
  await assert.rejects(t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY' }, randomUUID()), rejectsWith(503, 'PRO_TEMPORARILY_UNAVAILABLE'));
  assert.deepEqual(t.provider.charges, []);
});

test('a declined purchase is 402 and ends; a new purchase may follow', async () => {
  const t = setup();
  const key = randomUUID();
  await assert.rejects(t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.DECLINE }, key), rejectsWith(402, 'PAYMENT_DECLINED'));
  await assert.rejects(t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.DECLINE }, key), rejectsWith(402, 'PAYMENT_DECLINED'), 'replay answers the same');
  assert.equal((await t.sub())!.endedReason, 'PAYMENT_DECLINED');
  assert.deepEqual(await t.service.entitlement('m1', SUPER), { plan: 'FREE', source: 'NONE' });
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
});

test('provider down mid-purchase: 503, then a retry with the same key (or the job) charges exactly once', async () => {
  for (const finish of ['retry', 'job'] as const) {
    const t = setup();
    const key = randomUUID();
    t.provider.down = true;
    await assert.rejects(t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, key), rejectsWith(503, 'PRO_TEMPORARILY_UNAVAILABLE'));
    assert.equal((await t.sub())!.status, 'PENDING');
    await assert.rejects(t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY' }, randomUUID()), rejectsWith(409, 'PRO_PURCHASE_IN_PROGRESS'));
    t.provider.down = false;
    if (finish === 'retry') await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, key);
    else {
      t.clock.advance(20 * 60_000);
      await t.service.runDue();
    }
    assert.equal((await t.sub())!.status, 'ACTIVE', finish);
    await t.service.runDue();
    assert.deepEqual(t.charged(), ['PURCHASE:79900'], finish);
  }
});

test('renewal: charged once per period on the anniversary, even when two instances run the job', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.clock.set('2026-02-10T09:00:01.000Z');
  await Promise.all([t.service.runDue(), t.service.runDue()]);
  await t.service.runDue();
  assert.deepEqual(t.charged(), ['PURCHASE:79900', 'RENEWAL:79900']);
  const s = await t.sub();
  assert.deepEqual([s!.status, s!.periodIndex, s!.currentPeriodStart, s!.currentPeriodEnd],
    ['ACTIVE', 1, '2026-02-10T09:00:00.000Z', '2026-03-10T09:00:00.000Z']);
  assert.ok((await t.kinds()).includes('PRO_RENEWED'));
});

test('renewal checks State first: a member covered by the membership is not charged', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.state.set('m1', { tier: INFINITY }); // e.g. an operator grant; no handover event reached us
  t.clock.set('2026-02-10T10:00:00.000Z');
  await t.service.runDue();
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
  assert.equal((await t.sub())!.endedReason, 'INCLUDED_IN_MEMBERSHIP');
});

test('renewal never charges blindly: State down defers it; Pro continues meanwhile', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.setStateDown(true);
  t.clock.set('2026-02-10T10:00:00.000Z');
  await t.service.runDue();
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
  assert.equal((await t.service.entitlement('m1', SUPER)).plan, 'PRO', 'within the leeway');
  t.setStateDown(false);
  t.clock.advance(20 * 60_000);
  await t.service.runDue();
  assert.deepEqual(t.charged(), ['PURCHASE:79900', 'RENEWAL:79900']);
});

test('declined renewals: grace with one retry a day, Pro meanwhile, ended after 3 days', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.DECLINE_RENEWAL }, randomUUID());
  t.clock.set('2026-02-10T09:00:01.000Z');
  await t.service.runDue();
  assert.equal((await t.sub())!.status, 'GRACE');
  assert.equal((await t.service.entitlement('m1', SUPER)).plan, 'PRO');
  await t.service.runDue(); // not due again yet
  for (let day = 1; day <= 3; day++) {
    t.clock.advance(DAY);
    await t.service.runDue();
  }
  const s = await t.sub();
  assert.deepEqual([s!.status, s!.endedReason], ['ENDED', 'PAYMENT_FAILED']);
  assert.equal(t.provider.charges.filter((c) => c.kind === 'RENEWAL').length, 4, 'first attempt + 3 daily retries');
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
  assert.equal((await t.service.entitlement('m1', SUPER)).plan, 'FREE');
  const kinds = await t.kinds();
  assert.equal(kinds.filter((k) => k === 'PRO_RENEWAL_FAILED').length, 1);
  assert.ok(kinds.includes('PRO_ENDED'));
});

test('auto-renew off: Pro to the end of the period, then it ends with no charge', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  await t.service.setAutoRenew('m1', false);
  t.clock.set('2026-02-09T00:00:00.000Z');
  assert.equal((await t.service.entitlement('m1', SUPER)).plan, 'PRO');
  t.clock.set('2026-02-10T09:00:01.000Z');
  assert.equal((await t.service.entitlement('m1', SUPER)).plan, 'FREE', 'no leeway without auto-renew');
  await t.service.runDue();
  assert.deepEqual([(await t.sub())!.status, (await t.sub())!.endedReason], ['ENDED', 'CANCELLED']);
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
});

test('handover, monthly: renewal stops, the month is not refunded, nothing more is charged', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.clock.set('2026-01-20T00:00:00.000Z');
  assert.equal(await t.service.handleHandover('m1', 'act-1', 'evt-1'), 'settled');
  assert.deepEqual(t.confirmed, ['act-1']);
  const paused = await t.sub();
  assert.deepEqual([paused!.pausedForMembership, paused!.autoRenew, paused!.refund], [true, false, undefined]);
  await assert.rejects(t.service.setAutoRenew('m1', true), rejectsWith(409, 'PRO_PAUSED_FOR_MEMBERSHIP'));
  t.state.set('m1', { tier: INFINITY });
  t.clock.set('2026-02-10T10:00:00.000Z');
  await t.service.runDue();
  assert.equal((await t.sub())!.endedReason, 'INCLUDED_IN_MEMBERSHIP');
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
  assert.deepEqual(t.provider.refunds, []);
});

test('handover, monthly, then the membership ends within the month: Pro carries on as before', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  await t.service.handleHandover('m1', 'act-1', 'evt-1');
  t.clock.set('2026-02-10T10:00:00.000Z'); // State: the member is back on Super
  await t.service.runDue();
  const s = await t.sub();
  assert.deepEqual([s!.status, s!.pausedForMembership, s!.autoRenew, s!.periodIndex], ['ACTIVE', false, true, 1]);
  assert.deepEqual(t.charged(), ['PURCHASE:79900', 'RENEWAL:79900']);
  assert.ok((await t.kinds()).includes('PRO_RESUMED'));
});

test('handover, yearly: remaining months refunded once at the end of the month in progress, after checking State', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'YEARLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.clock.set('2026-04-15T00:00:00.000Z');
  await t.service.handleHandover('m1', 'act-1', 'evt-1');
  const scheduled = (await t.sub())!.refund!;
  assert.deepEqual(scheduled, { status: 'SCHEDULED', amountMinor: 399_933, dueAt: '2026-05-10T09:00:00.000Z' });
  const view = await t.service.memberState('m1', INFINITY);
  assert.ok(view.notices.some((n) => n.kind === 'PRO_REFUND_SCHEDULED' && n.amountMinor === 399_933 && n.at === scheduled.dueAt));
  t.state.set('m1', { tier: INFINITY });
  t.clock.set('2026-05-01T00:00:00.000Z');
  await t.service.runDue();
  assert.equal(t.provider.refunds.length, 0, 'not before the end of the month in progress');
  t.clock.set('2026-05-10T09:00:01.000Z');
  await Promise.all([t.service.runDue(), t.service.runDue()]);
  await t.service.runDue();
  assert.deepEqual(t.provider.refunds.map((r) => r.amountMinor), [399_933]);
  const s = await t.sub();
  assert.deepEqual([s!.status, s!.endedReason, s!.refund!.status, s!.currentPeriodEnd], ['ENDED', 'REFUNDED', 'ISSUED', '2026-05-10T09:00:00.000Z']);
  assert.ok((await t.kinds()).includes('PRO_REFUND_ISSUED'));
  assert.deepEqual(t.charged(), ['PURCHASE:599900']);
});

test('handover, yearly, membership gone by the refund date: no refund, the yearly plan just continues', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'YEARLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.clock.set('2026-04-15T00:00:00.000Z');
  await t.service.handleHandover('m1', 'act-1', 'evt-1');
  t.clock.set('2026-05-10T09:00:01.000Z'); // State: Super again
  await t.service.runDue();
  const s = await t.sub();
  assert.deepEqual([s!.status, s!.pausedForMembership, s!.autoRenew, s!.refund!.status], ['ACTIVE', false, true, 'CANCELLED']);
  assert.deepEqual(t.provider.refunds, []);
  assert.equal((await t.service.entitlement('m1', SUPER)).plan, 'PRO');
  assert.ok((await t.kinds()).includes('PRO_REFUND_CANCELLED'));
});

test('handover is idempotent; a purchase mid-charge makes it retry later; State down leaves it unconfirmed', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  await t.service.handleHandover('m1', 'act-1', 'evt-1');
  const before = await t.kinds();
  assert.equal(await t.service.handleHandover('m1', 'act-1', 'evt-1'), 'duplicate');
  assert.deepEqual(await t.kinds(), before);
  assert.deepEqual(t.confirmed, ['act-1', 'act-1']);

  const p = setup();
  p.provider.down = true;
  await assert.rejects(p.service.purchase('m2', SUPER, { billingPeriod: 'MONTHLY' }, randomUUID()));
  await assert.rejects(p.service.handleHandover('m2', 'act-2', 'evt-2'), ProRetryLaterError);

  const d = setup();
  d.setStateDown(true);
  await assert.rejects(d.service.handleHandover('m3', 'act-3', 'evt-3'), MembershipUnavailableError);
  d.setStateDown(false);
  assert.equal(await d.service.handleHandover('m3', 'act-3', 'evt-3'), 'settled', 'the redelivery confirms');
});

test('keep Pro: scheduled on the membership end date from State; nothing charged until then; then one charge', async () => {
  const t = setup();
  const endsAt = '2026-03-01T00:00:00.000Z';
  await assert.rejects(t.service.continueAfterMembership('m1', SUPER, { billingPeriod: 'MONTHLY' }, randomUUID()), rejectsWith(409, 'MEMBERSHIP_NOT_ENDING'));
  t.state.set('m1', { tier: INFINITY });
  await assert.rejects(t.service.continueAfterMembership('m1', INFINITY, { billingPeriod: 'MONTHLY' }, randomUUID()), rejectsWith(409, 'MEMBERSHIP_NOT_ENDING'));
  t.state.set('m1', { tier: INFINITY, endsAt });
  await t.service.continueAfterMembership('m1', INFINITY, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  assert.deepEqual([(await t.cont())!.status, (await t.cont())!.startsAt], ['SCHEDULED', endsAt]);
  const view = await t.service.memberState('m1', INFINITY);
  assert.ok(view.notices.some((n) => n.kind === 'PRO_CONTINUATION_SCHEDULED' && n.at === endsAt && n.amountMinor === 79_900));
  await t.service.runDue();
  assert.deepEqual(t.provider.charges, []);
  t.state.set('m1', { tier: SUPER, lastEnded: { at: endsAt, reason: 'EXPIRED', tier: INFINITY } });
  t.clock.set('2026-03-01T00:00:01.000Z');
  await t.service.runDue();
  await t.service.runDue();
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
  assert.equal((await t.cont())!.status, 'STARTED');
  const s = await t.sub();
  assert.deepEqual([s!.status, s!.currentPeriodEnd], ['ACTIVE', '2026-04-01T00:00:01.000Z']);
  assert.ok((await t.kinds()).includes('PRO_CONTINUATION_STARTED'));
});

test('keep Pro withdrawn before it starts: nothing charged; withdrawing after it started is refused', async () => {
  const t = setup();
  t.state.set('m1', { tier: INFINITY, endsAt: '2026-03-01T00:00:00.000Z' });
  await t.service.continueAfterMembership('m1', INFINITY, { billingPeriod: 'YEARLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  await t.service.cancelContinuation('m1');
  await t.service.cancelContinuation('m1'); // idempotent
  t.clock.set('2026-03-02T00:00:00.000Z');
  t.state.set('m1', { tier: SUPER });
  await t.service.runDue();
  assert.deepEqual(t.provider.charges, []);

  const u = setup();
  u.state.set('m1', { tier: INFINITY, endsAt: '2026-03-01T00:00:00.000Z' });
  await u.service.continueAfterMembership('m1', INFINITY, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  u.state.set('m1', { tier: SUPER });
  u.clock.set('2026-03-01T00:00:01.000Z');
  await u.service.runDue();
  await assert.rejects(u.service.cancelContinuation('m1'), rejectsWith(409, 'CONTINUATION_ALREADY_STARTED'));
});

test('keep Pro, membership ended early: free Pro until the original end date, first charge on that date', async () => {
  const t = setup();
  const endsAt = '2026-03-01T00:00:00.000Z';
  t.state.set('m1', { tier: INFINITY, endsAt });
  await t.service.continueAfterMembership('m1', INFINITY, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.clock.set('2026-02-05T00:00:00.000Z');
  t.state.set('m1', { tier: SUPER, lastEnded: { at: '2026-02-04T00:00:00.000Z', reason: 'PAYMENT_FAILED', tier: INFINITY } });
  assert.deepEqual(await t.service.entitlement('m1', SUPER), { plan: 'PRO', source: 'COMPLIMENTARY' });
  await t.service.runDue();
  assert.deepEqual(t.provider.charges, [], 'nothing before the original end date');
  t.clock.set('2026-03-01T00:00:01.000Z');
  await t.service.runDue();
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
});

test('keep Pro, membership refunded or charged back: no free period, Pro starts (and is charged) now', async () => {
  for (const reason of ['REFUNDED', 'CHARGEBACK'] as const) {
    const t = setup();
    t.state.set('m1', { tier: INFINITY, endsAt: '2026-03-01T00:00:00.000Z' });
    await t.service.continueAfterMembership('m1', INFINITY, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
    t.clock.set('2026-02-05T00:00:00.000Z');
    t.state.set('m1', { tier: SUPER, lastEnded: { at: '2026-02-04T00:00:00.000Z', reason, tier: INFINITY } });
    assert.deepEqual(await t.service.entitlement('m1', SUPER), { plan: 'FREE', source: 'NONE' }, reason);
    await t.service.runDue();
    assert.deepEqual(t.charged(), ['PURCHASE:79900'], reason);
    assert.equal((await t.service.entitlement('m1', SUPER)).source, 'SUBSCRIPTION');
  }
});

test('keep Pro, membership renewed after all: the plan is cancelled, nothing is charged', async () => {
  for (const how of ['handover', 'job'] as const) {
    const t = setup();
    t.state.set('m1', { tier: INFINITY, endsAt: '2026-03-01T00:00:00.000Z' });
    await t.service.continueAfterMembership('m1', INFINITY, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
    if (how === 'handover') await t.service.handleHandover('m1', 'act-2', 'evt-2');
    t.state.set('m1', { tier: INFINITY });
    t.clock.set('2026-03-01T00:00:01.000Z');
    await t.service.runDue();
    assert.equal((await t.cont())!.status, 'CANCELLED', how);
    assert.deepEqual(t.provider.charges, [], how);
  }
});

test('keep Pro on top of a paused yearly plan: never two plans at once', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'YEARLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.clock.set('2026-04-15T00:00:00.000Z');
  await t.service.handleHandover('m1', 'act-1', 'evt-1');
  t.state.set('m1', { tier: INFINITY, endsAt: '2026-05-01T00:00:00.000Z' }); // ends before the refund date
  await t.service.continueAfterMembership('m1', INFINITY, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  t.state.set('m1', { tier: SUPER, lastEnded: { at: '2026-05-01T00:00:00.000Z', reason: 'EXPIRED', tier: INFINITY } });
  t.clock.set('2026-05-01T00:00:01.000Z');
  await t.service.runDue();
  t.clock.set('2026-05-10T09:00:01.000Z');
  await t.service.runDue();
  // The yearly plan resumes (refund cancelled); the kept monthly plan is not needed.
  assert.equal((await t.cont())!.status, 'CANCELLED');
  assert.deepEqual([(await t.sub())!.billingPeriod, (await t.sub())!.status], ['YEARLY', 'ACTIVE']);
  assert.deepEqual(t.charged(), ['PURCHASE:599900']);
  assert.deepEqual(t.provider.refunds, []);
});

test('account erasure removes the Pro rows (ledger kept) so nothing can renew', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  assert.ok((await t.service.eraseUser('m1')) >= 3);
  assert.equal(await t.sub(), undefined);
  assert.equal(t.table.docs('notice:').length, 0);
  assert.equal(t.table.docs('ledger:').length, 1, 'accounting rows stay; they hold no member id');
  assert.ok(!JSON.stringify(t.table.docs('ledger:')).includes('m1'));
  t.clock.set('2026-02-10T10:00:00.000Z');
  await t.service.runDue();
  assert.deepEqual(t.charged(), ['PURCHASE:79900']);
});

test('the Pro table being down is an error, never "Free" (which would drop a paying member\'s sessions)', async () => {
  const t = setup();
  t.table.down = true;
  await assert.rejects(t.service.entitlement('m1', SUPER));
  assert.deepEqual(await t.service.entitlement('m1', INFINITY), { plan: 'PRO', source: 'MEMBERSHIP' }, 'membership needs no lookup');
});

test('due index: the job reads only past index hours, cleans stale entries, and backfills older rows once', async () => {
  const t = setup();
  await t.service.purchase('m1', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  await t.service.purchase('m2', SUPER, { billingPeriod: 'YEARLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  const entries = () => [...t.table.rows.keys()].filter((k) => k.startsWith('due:')).map((k) => k.split('\u0000')[0]).sort();

  // Before the anniversary nothing is due; the index has one entry per renewal (plus purchase leftovers).
  t.clock.set('2026-02-10T08:59:00.000Z');
  assert.equal(await t.service.runDue(), 0);
  assert.ok(entries().includes('due:2026021009') && entries().includes('due:2027011009'), entries().join());
  assert.equal(t.table.fullScans, 1, 'the backfill reads the whole table once');

  t.clock.set('2026-02-10T09:00:01.000Z');
  assert.equal(await t.service.runDue(), 1);
  assert.deepEqual(t.charged(), ['PURCHASE:79900', 'PURCHASE:599900', 'RENEWAL:79900']);
  await t.service.runDue();
  assert.ok(!entries().includes('due:2026021009'), 'the renewed hour is cleaned');
  assert.ok(entries().includes('due:2026031009'), 'the next renewal is indexed');
  assert.equal(t.table.fullScans, 1);

  // Erasure leaves no index entry behind.
  await t.service.eraseUser('m2');
  assert.ok(!entries().includes('due:2027011009'));

  // A row written before the index existed (no entry, no meta row) is found by the one-time backfill.
  const old = setup();
  await old.service.purchase('m3', SUPER, { billingPeriod: 'MONTHLY', paymentToken: FAKE_TOKENS.OK }, randomUUID());
  for (const k of [...old.table.rows.keys()]) if (k.startsWith('due:') || k.startsWith('meta\u0000')) old.table.rows.delete(k);
  old.clock.set('2026-02-10T09:00:01.000Z');
  await new ProStore(old.table).due([SUBSCRIPTION_ROW], old.clock.now(), 10).then((rows) => assert.equal(rows.length, 1));
  assert.equal(await old.service.runDue(), 1);
  assert.deepEqual(old.charged(), ['PURCHASE:79900', 'RENEWAL:79900']);
});
