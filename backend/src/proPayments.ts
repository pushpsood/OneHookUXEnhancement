import { createHash } from 'node:crypto';
import type { ProBillingPeriod } from './generated/mrOneHookModels';

/**
 * Payment rail for Mr OneHook Pro. Every charge and refund goes through this interface, so no other module
 * knows which provider is in use.
 *
 * The shape follows StoreKit 2 / App Store Server API, the rail iOS must use for in-app digital
 * subscriptions:
 *  - a purchase carries the provider's proof (`paymentToken`: for the App Store the signed transaction JWS,
 *    bought with `appAccountToken` = the member's Cognito `sub`), and the provider returns a stable
 *    `transactionId` (App Store `originalTransactionId`);
 *  - renewals and refunds are keyed by that id and an idempotency key, so a retried call never charges or
 *    refunds twice;
 *  - `capabilities` says what the server may start itself. The App Store renews on its own and only Apple
 *    can refund, so an App Store provider reports `serverRenewals: false, serverRefunds: false` and its
 *    renewals arrive as App Store Server Notifications instead (a later route); the service then records
 *    the renewal rather than charging.
 *
 * Errors: a declined payment is a result (`DECLINED`), never an exception. An exception means the provider
 * could not be reached or answered something unusable: nothing is known to have happened, and the caller
 * retries later with the same idempotency key.
 */
export interface ProChargeRequest {
  /** Unique per charge attempt; the same key always returns the first attempt's result. */
  idempotencyKey: string;
  userId: string;
  kind: 'PURCHASE' | 'RENEWAL';
  billingPeriod: ProBillingPeriod;
  amountMinor: number;
  currency: string;
  /** The provider's purchase proof (PURCHASE), or the stored token for renewals. */
  paymentToken?: string;
  /** RENEWAL: the subscription's provider id. */
  transactionId?: string;
}

export type ProChargeResult =
  | { outcome: 'SUCCEEDED'; transactionId: string }
  | { outcome: 'DECLINED' };

export interface ProRefundRequest {
  idempotencyKey: string;
  userId: string;
  transactionId: string;
  amountMinor: number;
  currency: string;
  reason: 'INCLUDED_IN_MEMBERSHIP';
}

export interface ProPaymentProvider {
  readonly name: string;
  readonly capabilities: { serverRenewals: boolean; serverRefunds: boolean };
  charge(request: ProChargeRequest): Promise<ProChargeResult>;
  refund(request: ProRefundRequest): Promise<{ refundId: string }>;
}

/** The provider could not be reached or answered something unusable. Retry later with the same key. */
export class ProPaymentUnavailableError extends Error {}

/** Test tokens of {@link FakeProPaymentProvider}. Any other token behaves like {@link FAKE_TOKENS.OK}. */
export const FAKE_TOKENS = {
  OK: 'fake-ok',
  /** The purchase is declined. */
  DECLINE: 'fake-decline',
  /** The purchase succeeds; every renewal is declined. */
  DECLINE_RENEWAL: 'fake-decline-renewal',
  /** Every call fails as if the provider were down. */
  ERROR: 'fake-error',
} as const;

export interface FakeChargeAttempt extends ProChargeRequest {
  result: ProChargeResult;
}

/**
 * A payment provider that moves no money, for gamma and tests (config refuses it in prod). It is
 * idempotent per key like a real provider and records every attempt, so tests can assert exactly what
 * would have been charged or refunded (e.g. "an Infinity member: 0 charges").
 */
export class FakeProPaymentProvider implements ProPaymentProvider {
  readonly name = 'fake';
  readonly capabilities = { serverRenewals: true, serverRefunds: true };
  readonly charges: FakeChargeAttempt[] = [];
  readonly refunds: Array<ProRefundRequest & { refundId: string }> = [];
  private readonly byKey = new Map<string, ProChargeResult>();
  private readonly refundByKey = new Map<string, string>();
  /** Set to make every call fail (provider outage). */
  down = false;

  async charge(request: ProChargeRequest): Promise<ProChargeResult> {
    if (this.down || request.paymentToken === FAKE_TOKENS.ERROR) throw new ProPaymentUnavailableError('fake provider down');
    const previous = this.byKey.get(request.idempotencyKey);
    if (previous) return previous;
    const declined = request.kind === 'PURCHASE'
      ? request.paymentToken === FAKE_TOKENS.DECLINE
      : request.paymentToken === FAKE_TOKENS.DECLINE_RENEWAL;
    const result: ProChargeResult = declined
      ? { outcome: 'DECLINED' }
      : {
          outcome: 'SUCCEEDED',
          // A purchase starts a provider subscription id; renewals keep it (App Store originalTransactionId).
          transactionId: request.transactionId ?? `fake_${digest(request.idempotencyKey)}`,
        };
    this.byKey.set(request.idempotencyKey, result);
    this.charges.push({ ...request, result });
    return result;
  }

  async refund(request: ProRefundRequest): Promise<{ refundId: string }> {
    if (this.down) throw new ProPaymentUnavailableError('fake provider down');
    const previous = this.refundByKey.get(request.idempotencyKey);
    if (previous) return { refundId: previous };
    const refundId = `fake_refund_${digest(request.idempotencyKey)}`;
    this.refundByKey.set(request.idempotencyKey, refundId);
    this.refunds.push({ ...request, refundId });
    return { refundId };
  }

  /** Successful charges (what a member would have paid). */
  succeededCharges(): FakeChargeAttempt[] {
    return this.charges.filter((c) => c.result.outcome === 'SUCCEEDED');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}
