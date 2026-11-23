import { createHash, randomUUID } from 'node:crypto';
import type { SubscriptionTier } from 'onehook-api-client';
import type {
  ProBillingPeriod,
  ProEndedReason,
  ProNotice,
  ProNoticeKind,
  ProRefundStatus,
  ProSubscriptionStatus,
} from './generated/mrOneHookModels';
import {
  MembershipUnavailableError,
  NO_GRACE_END_REASONS,
  type MembershipDirectory,
} from './membershipDirectory';
import { ProPaymentUnavailableError, type ProChargeResult, type ProPaymentProvider } from './proPayments';
import { RowChangedError, RowExistsError, type ProStore, type Stored } from './proStore';

/**
 * Mr OneHook Pro: a subscription of its own, separate from the OneHook membership.
 *
 * Who is Pro (checked on every chat turn, see {@link ProSubscriptionService.entitlement}):
 *  1. a verified token tier that includes Pro (the top membership tier): Pro, with no lookup at all;
 *  2. a paid subscription that is ACTIVE or in GRACE;
 *  3. a "Keep Mr OneHook Pro" scheduled after a membership that ended early: free until the original end.
 *
 * Money moves only in {@link ProSubscriptionService.purchase} and the renewal job
 * ({@link ProSubscriptionService.runDue}). Before any renewal, first charge of a kept subscription or
 * refund, the job asks the membership directory (State) whether the membership covers Pro now; when it
 * cannot tell, it waits and asks again, it never charges blindly. Every charge and refund has a ledger row
 * written insert-if-absent and a provider idempotency key derived from it, so two instances, a crash or a
 * retry can never charge a period twice.
 *
 * When a membership that includes Pro starts (a handover event from State), the member's Pro subscription
 * stops renewing. The Pro month in progress is never refunded (the membership covers it regardless). A
 * yearly plan's remaining whole months are refunded at the end of that month, only if the member still
 * holds the membership then; otherwise the yearly plan simply continues. Mr OneHook then confirms the
 * handover and State finalizes the membership.
 */

export const SUBSCRIPTION_ROW = 'subscription';
export const CONTINUATION_ROW = 'continuation';
const HANDOVER_ROW = 'handover';
const NOTICE_PREFIX = 'notice:';
const LEDGER_PREFIX = 'ledger:';
const EVENT_PREFIX = 'event:';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Renewal declines: retried once a day; Pro continues meanwhile; ends after this many days. */
export const GRACE_DAYS = 3;
/** When State or the provider cannot answer, the job tries again after this long. */
const RETRY_DEFER_MS = 15 * 60_000;
/** A claimed due row is owned by one instance for this long. */
const LEASE_MS = 2 * 60_000;
/** A renewal that cannot run yet (State or provider down) keeps Pro for this long past the period end. */
const RENEWAL_LEEWAY_MS = 6 * HOUR;
/** After a handover, a token may still show the old tier for up to an hour: purchases check State. */
const HANDOVER_RECHECK_MS = 24 * HOUR;
/** A member on free kept-Pro time: re-check State for a refund or chargeback at most this often. */
const GRACE_RECHECK_MS = HOUR;
const MAX_NOTICES_SHOWN = 20;

// ── Stored documents ─────────────────────────────────────────────────────────

export interface SubscriptionDoc {
  schemaVersion: 1;
  subscriptionId: string;
  userId: string;
  status: ProSubscriptionStatus;
  billingPeriod: ProBillingPeriod;
  priceMinor: number;
  currency: string;
  autoRenew: boolean;
  pausedForMembership: boolean;
  /** The activation that paused it (idempotent handover). */
  pausedByActivationId?: string;
  /** The member's auto-renew choice before the pause; restored if the membership goes away. */
  autoRenewBeforePause?: boolean;
  /** 0 for the first paid period, +1 per renewal. */
  periodIndex: number;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  graceUntil?: string;
  /** GRACE: the next renewal retry. */
  retryAt?: string;
  /** Renewal attempts for the next period (0 = none yet). */
  renewalAttempts: number;
  refund?: RefundDoc;
  endedReason?: ProEndedReason;
  endedAt?: string;
  provider: string;
  /** The provider's subscription id (App Store originalTransactionId). */
  transactionId?: string;
  /** The provider's purchase proof, reused for server-started renewals (fake provider, card gateways). */
  paymentToken?: string;
  /** Idempotency-Key of the purchase (or of the kept-Pro request that started it). */
  purchaseKey: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RefundDoc {
  status: ProRefundStatus;
  amountMinor: number;
  dueAt: string;
  issuedAt?: string;
  refundId?: string;
}

export interface ContinuationDoc {
  schemaVersion: 1;
  continuationId: string;
  userId: string;
  status: 'SCHEDULED' | 'STARTING' | 'STARTED' | 'CANCELLED';
  billingPeriod: ProBillingPeriod;
  paymentToken?: string;
  /** The membership's original end: the first charge. */
  startsAt: string;
  idempotencyKey: string;
  /** Set when the first charge began, so a crash mid-way resumes the same subscription. */
  subscriptionId?: string;
  /** Start now instead of `startsAt` (the membership was refunded or charged back). */
  startNow?: boolean;
  graceCheckedAt?: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
}

interface HandoverDoc {
  schemaVersion: 1;
  activationId: string;
  at: string;
}

/** A stored notice: the API's `ProNotice` plus the schema version. */
export type NoticeDoc = ProNotice & { schemaVersion: 1 };

interface LedgerDoc {
  schemaVersion: 1;
  kind: 'CHARGE' | 'REFUND';
  subscriptionId: string;
  periodIndex: number;
  attempt: number;
  amountMinor: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'DECLINED';
  providerRef?: string;
  createdAt: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireDoc<T>(value: unknown, check: (record: Record<string, unknown>) => boolean, what: string): T {
  if (!isRecord(value) || value.schemaVersion !== 1 || !check(value)) throw new Error(`Invalid ${what} row`);
  return value as T;
}

const SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set<ProSubscriptionStatus>(['PENDING', 'SCHEDULED', 'ACTIVE', 'GRACE', 'ENDED']);
const PERIODS: ReadonlySet<string> = new Set<ProBillingPeriod>(['MONTHLY', 'YEARLY']);

export const parseSubscription = (value: unknown): SubscriptionDoc => requireDoc<SubscriptionDoc>(value, (r) =>
  typeof r.subscriptionId === 'string' && typeof r.userId === 'string'
  && typeof r.status === 'string' && SUBSCRIPTION_STATUSES.has(r.status)
  && typeof r.billingPeriod === 'string' && PERIODS.has(r.billingPeriod)
  && Number.isSafeInteger(r.priceMinor) && typeof r.autoRenew === 'boolean'
  && typeof r.pausedForMembership === 'boolean' && Number.isSafeInteger(r.periodIndex)
  && Number.isSafeInteger(r.renewalAttempts) && typeof r.purchaseKey === 'string', 'subscription');

export const parseContinuation = (value: unknown): ContinuationDoc => requireDoc<ContinuationDoc>(value, (r) =>
  typeof r.continuationId === 'string' && typeof r.userId === 'string'
  && ['SCHEDULED', 'STARTING', 'STARTED', 'CANCELLED'].includes(String(r.status))
  && typeof r.billingPeriod === 'string' && PERIODS.has(r.billingPeriod)
  && typeof r.startsAt === 'string' && typeof r.idempotencyKey === 'string', 'continuation');

const parseHandover = (value: unknown): HandoverDoc => requireDoc<HandoverDoc>(value, (r) =>
  typeof r.activationId === 'string' && typeof r.at === 'string', 'handover');

export const parseNotice = (value: unknown): NoticeDoc => requireDoc<NoticeDoc>(value, (r) =>
  typeof r.noticeId === 'string' && typeof r.kind === 'string' && typeof r.createdAt === 'string', 'notice');

const parseLedger = (value: unknown): LedgerDoc => requireDoc<LedgerDoc>(value, (r) =>
  (r.kind === 'CHARGE' || r.kind === 'REFUND') && typeof r.status === 'string', 'ledger');

// ── Dates ────────────────────────────────────────────────────────────────────

/** `iso` plus `months` calendar months in UTC, clamped to the month's last day (Jan 31 + 1 = Feb 28/29). */
export function addMonths(iso: string, months: number): string {
  const date = new Date(iso);
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

function periodMonths(period: ProBillingPeriod): number {
  return period === 'YEARLY' ? 12 : 1;
}

/**
 * The yearly refund when a membership that includes Pro starts at `at`: the Pro month in progress is
 * kept (never refunded), the remaining whole months are refunded at the end of it.
 */
export function yearlyRefund(periodStart: string, priceMinor: number, at: string): { dueAt: string; amountMinor: number } {
  let monthsUsed = 1;
  while (monthsUsed < 12 && Date.parse(addMonths(periodStart, monthsUsed)) <= Date.parse(at)) monthsUsed += 1;
  return {
    dueAt: addMonths(periodStart, monthsUsed),
    amountMinor: Math.floor((priceMinor * (12 - monthsUsed)) / 12),
  };
}

// ── Errors and results ──────────────────────────────────────────────────────

/** A request the member can act on: `status` and `code` go to the client as is. */
export class ProRequestError extends Error {
  constructor(readonly status: 402 | 404 | 409 | 503, readonly code: string) {
    super(code);
  }
}

/** A handover event that cannot be settled yet (e.g. a purchase is being charged): redeliver it. */
export class ProRetryLaterError extends Error {}

export type ProEntitlement =
  | { plan: 'PRO'; source: 'MEMBERSHIP' | 'SUBSCRIPTION' | 'COMPLIMENTARY' }
  | { plan: 'FREE'; source: 'NONE' };

export interface ProMemberState {
  entitlement: ProEntitlement;
  subscription?: SubscriptionDoc;
  continuation?: ContinuationDoc;
  notices: NoticeDoc[];
  canPurchase: boolean;
}

export interface ProServiceLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

const consoleLogger: ProServiceLogger = {
  info: (event) => console.info(JSON.stringify(event)),
  warn: (event) => console.warn(JSON.stringify(event)),
  error: (event) => console.error(JSON.stringify(event)),
};

export interface ProServiceOptions {
  store: ProStore;
  /** Absent: purchases answer 503 PAYMENTS_NOT_CONFIGURED; membership Pro still works. */
  provider?: ProPaymentProvider;
  directory: MembershipDirectory;
  includedTiers: readonly SubscriptionTier[];
  prices: Readonly<Record<ProBillingPeriod, number>>;
  currency: string;
  now?: () => Date;
  logger?: ProServiceLogger;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** Short stable id for notices and ledger keys (no member data in it). */
function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 22);
}

export class ProSubscriptionService {
  private readonly store: ProStore;
  private readonly provider: ProPaymentProvider | undefined;
  private readonly directory: MembershipDirectory;
  private readonly includedTiers: ReadonlySet<SubscriptionTier>;
  private readonly prices: Readonly<Record<ProBillingPeriod, number>>;
  private readonly currency: string;
  private readonly now: () => Date;
  private readonly logger: ProServiceLogger;

  constructor(options: ProServiceOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.directory = options.directory;
    this.includedTiers = new Set(options.includedTiers);
    this.prices = options.prices;
    this.currency = options.currency;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? consoleLogger;
  }

  get paymentsConfigured(): boolean {
    return this.provider !== undefined;
  }

  /** True when this membership tier includes Pro (the token's tier, or State's). */
  includesPro(tier: SubscriptionTier | undefined): boolean {
    return tier !== undefined && this.includedTiers.has(tier);
  }

  offers(): Array<{ billingPeriod: ProBillingPeriod; priceMinor: number; currency: string }> {
    return (['MONTHLY', 'YEARLY'] as const).map((billingPeriod) => ({
      billingPeriod, priceMinor: this.prices[billingPeriod], currency: this.currency,
    }));
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * The member's plan for one request. A membership tier that includes Pro needs no lookup. Otherwise the
   * Pro table is read; if it cannot be read this throws (the caller answers 503), because treating a
   * paying member as Free would cost them messages and saved sessions.
   */
  async entitlement(userId: string, tier: SubscriptionTier): Promise<ProEntitlement> {
    if (this.includesPro(tier)) return { plan: 'PRO', source: 'MEMBERSHIP' };
    const now = this.now();
    const subscription = await this.store.read(userId, SUBSCRIPTION_ROW, parseSubscription);
    if (subscription && this.entitles(subscription.value, now)) return { plan: 'PRO', source: 'SUBSCRIPTION' };
    const continuation = await this.store.read(userId, CONTINUATION_ROW, parseContinuation);
    if (continuation && await this.complimentary(continuation, now)) return { plan: 'PRO', source: 'COMPLIMENTARY' };
    return { plan: 'FREE', source: 'NONE' };
  }

  async memberState(userId: string, tier: SubscriptionTier): Promise<ProMemberState> {
    const entitlement = await this.entitlement(userId, tier);
    const [subscription, continuation, notices] = await Promise.all([
      this.store.read(userId, SUBSCRIPTION_ROW, parseSubscription),
      this.store.read(userId, CONTINUATION_ROW, parseContinuation),
      this.store.list(userId, NOTICE_PREFIX, parseNotice),
    ]);
    const now = this.now();
    const scheduled = continuation && (continuation.value.status === 'SCHEDULED' || continuation.value.status === 'STARTING');
    const canPurchase = this.provider !== undefined
      && !this.includesPro(tier)
      && !(subscription && (this.entitles(subscription.value, now) || subscription.value.status === 'PENDING'))
      && !scheduled;
    return {
      entitlement,
      ...(subscription ? { subscription: subscription.value } : {}),
      ...(continuation ? { continuation: continuation.value } : {}),
      notices: notices
        .map((n) => n.value)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, MAX_NOTICES_SHOWN),
      canPurchase,
    };
  }

  /** ACTIVE (within the period, plus leeway while a renewal is pending) or GRACE (until graceUntil). */
  private entitles(sub: SubscriptionDoc, now: Date): boolean {
    const t = now.getTime();
    if (sub.status === 'ACTIVE' && sub.currentPeriodEnd) {
      const end = Date.parse(sub.currentPeriodEnd);
      return t < end || (sub.autoRenew && t < end + RENEWAL_LEEWAY_MS);
    }
    if (sub.status === 'GRACE' && sub.graceUntil) return t < Date.parse(sub.graceUntil);
    return false;
  }

  /**
   * Kept-Pro time: the member chose to keep Pro, the membership ended before the scheduled start, and it
   * did not end by refund or chargeback. The exception is checked with State at most hourly; when State
   * cannot answer, the member keeps the benefit (it is short-lived).
   */
  private async complimentary(stored: Stored<ContinuationDoc>, now: Date): Promise<boolean> {
    const cont = stored.value;
    if (cont.status !== 'SCHEDULED' || cont.startNow || now.getTime() >= Date.parse(cont.startsAt)) return false;
    if (cont.graceCheckedAt && now.getTime() - Date.parse(cont.graceCheckedAt) < GRACE_RECHECK_MS) return true;
    try {
      const snapshot = await this.directory.get(cont.userId);
      const ended = snapshot.lastEnded;
      const refunded = ended !== undefined && NO_GRACE_END_REASONS.has(ended.reason)
        && Date.parse(ended.at) >= Date.parse(cont.createdAt);
      const next: ContinuationDoc = refunded
        ? { ...cont, startNow: true, updatedAt: now.toISOString() }
        : { ...cont, graceCheckedAt: now.toISOString(), updatedAt: now.toISOString() };
      await this.store.replace(cont.userId, CONTINUATION_ROW, next, stored.etag, refunded ? now.toISOString() : cont.startsAt)
        .catch((error: unknown) => {
          if (!(error instanceof RowChangedError)) throw error;
        });
      if (refunded) this.logger.info({ event: 'pro.continuation_starts_now', reason: ended!.reason });
      return !refunded;
    } catch (error) {
      if (error instanceof MembershipUnavailableError) return true;
      throw error;
    }
  }

  // ── Member actions ─────────────────────────────────────────────────────────

  /** Buys Pro. Idempotent per `idempotencyKey`; never charges a member whose membership includes Pro. */
  async purchase(
    userId: string,
    tier: SubscriptionTier,
    input: { billingPeriod: ProBillingPeriod; paymentToken?: string },
    idempotencyKey: string,
  ): Promise<void> {
    if (!this.provider) throw new ProRequestError(503, 'PAYMENTS_NOT_CONFIGURED');
    if (this.includesPro(tier)) throw new ProRequestError(409, 'PRO_INCLUDED_IN_MEMBERSHIP');
    const now = this.now();

    // The token may still show the old tier for up to an hour after a handover: ask State then.
    const handover = await this.store.read(userId, HANDOVER_ROW, parseHandover);
    if (handover && now.getTime() - Date.parse(handover.value.at) < HANDOVER_RECHECK_MS) {
      const snapshot = await this.membership(userId);
      if (this.includesPro(snapshot.tier)) throw new ProRequestError(409, 'PRO_INCLUDED_IN_MEMBERSHIP');
    }
    const continuation = await this.store.read(userId, CONTINUATION_ROW, parseContinuation);
    if (continuation && (continuation.value.status === 'SCHEDULED' || continuation.value.status === 'STARTING')) {
      throw new ProRequestError(409, 'PRO_ALREADY_ACTIVE');
    }

    const existing = await this.store.read(userId, SUBSCRIPTION_ROW, parseSubscription);
    if (existing) {
      const sub = existing.value;
      if (sub.purchaseKey === idempotencyKey) {
        // A retry of this purchase: finish it if it was interrupted, else answer as before.
        if (sub.status === 'PENDING') await this.settlePending(existing, now, 'request');
        else if (sub.status === 'ENDED' && sub.endedReason === 'PAYMENT_DECLINED') throw new ProRequestError(402, 'PAYMENT_DECLINED');
        return;
      }
      if (sub.status === 'PENDING') throw new ProRequestError(409, 'PRO_PURCHASE_IN_PROGRESS');
      if (this.entitles(sub, now)) throw new ProRequestError(409, 'PRO_ALREADY_ACTIVE');
    }

    const record: SubscriptionDoc = {
      schemaVersion: 1,
      subscriptionId: randomUUID(),
      userId,
      status: 'PENDING',
      billingPeriod: input.billingPeriod,
      priceMinor: this.prices[input.billingPeriod],
      currency: this.currency,
      autoRenew: true,
      pausedForMembership: false,
      periodIndex: 0,
      renewalAttempts: 0,
      provider: this.provider.name,
      ...(input.paymentToken ? { paymentToken: input.paymentToken } : {}),
      purchaseKey: idempotencyKey,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    let etag: string;
    try {
      // If this process stops mid-charge, the renewal job settles the PENDING row with the same key.
      etag = await this.store.write(userId, SUBSCRIPTION_ROW, record, existing?.etag, new Date(now.getTime() + 5 * 60_000).toISOString());
    } catch (error) {
      if (error instanceof RowExistsError || error instanceof RowChangedError) throw new ProRequestError(409, 'PRO_PURCHASE_IN_PROGRESS');
      throw error;
    }
    await this.settlePending({ value: record, etag }, now, 'request');
  }

  /**
   * Charges the first period of a PENDING subscription (a purchase, or a kept-Pro start) and records the
   * outcome. From a request, a declined charge throws 402 and an unreachable provider throws 503 (the row
   * stays PENDING; a retry with the same key, or the job, finishes it without charging twice).
   */
  private async settlePending(stored: Stored<SubscriptionDoc>, now: Date, from: 'request' | 'job'): Promise<SubscriptionDoc> {
    const { leaseUntil: _lease, ...sub } = stored.value;
    let result: ProChargeResult;
    try {
      result = await this.charge(sub, 'PURCHASE', 0, 1);
    } catch (error) {
      if (error instanceof ProPaymentUnavailableError) {
        this.logger.warn({ event: 'pro.purchase_provider_unavailable', from });
        await this.store.replace(sub.userId, SUBSCRIPTION_ROW, { ...sub, updatedAt: now.toISOString() }, stored.etag,
          new Date(now.getTime() + RETRY_DEFER_MS).toISOString()).catch(() => undefined);
        if (from === 'request') throw new ProRequestError(503, 'PRO_TEMPORARILY_UNAVAILABLE');
        return sub;
      }
      throw error;
    }
    if (result.outcome === 'DECLINED') {
      const ended: SubscriptionDoc = {
        ...sub, status: 'ENDED', endedReason: 'PAYMENT_DECLINED', endedAt: now.toISOString(), autoRenew: false, updatedAt: now.toISOString(),
      };
      await this.store.replace(sub.userId, SUBSCRIPTION_ROW, ended, stored.etag);
      this.logger.info({ event: 'pro.purchase_declined', from });
      if (from === 'request') throw new ProRequestError(402, 'PAYMENT_DECLINED');
      await this.notify(sub.userId, 'PRO_ENDED', `${sub.subscriptionId}:declined`);
      return ended;
    }
    const start = now.toISOString();
    const end = addMonths(start, periodMonths(sub.billingPeriod));
    const active: SubscriptionDoc = {
      ...sub, status: 'ACTIVE', transactionId: result.transactionId, currentPeriodStart: start, currentPeriodEnd: end,
      updatedAt: start,
    };
    await this.store.replace(sub.userId, SUBSCRIPTION_ROW, active, stored.etag, end);
    await this.notify(sub.userId, 'PRO_PURCHASED', `${sub.subscriptionId}:purchased`, { amountMinor: sub.priceMinor, at: end });
    this.logger.info({ event: 'pro.purchased', billingPeriod: sub.billingPeriod, from });
    return active;
  }

  async setAutoRenew(userId: string, autoRenew: boolean): Promise<void> {
    const now = this.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await this.store.read(userId, SUBSCRIPTION_ROW, parseSubscription);
      const sub = stored?.value;
      if (!stored || !sub || sub.status === 'ENDED' || sub.status === 'SCHEDULED') throw new ProRequestError(404, 'PRO_SUBSCRIPTION_NOT_FOUND');
      if (sub.status === 'PENDING') throw new ProRequestError(409, 'PRO_PURCHASE_IN_PROGRESS');
      if (sub.pausedForMembership) throw new ProRequestError(409, 'PRO_PAUSED_FOR_MEMBERSHIP');
      if (sub.autoRenew === autoRenew) return;
      const next: SubscriptionDoc = { ...sub, autoRenew, updatedAt: now.toISOString() };
      try {
        await this.store.replace(userId, SUBSCRIPTION_ROW, next, stored.etag, this.nextActionOf(next));
        this.logger.info({ event: 'pro.auto_renew_changed', autoRenew });
        return;
      } catch (error) {
        if (!(error instanceof RowChangedError)) throw error;
      }
    }
    throw new ProRequestError(503, 'PRO_TEMPORARILY_UNAVAILABLE');
  }

  /**
   * "Keep Mr OneHook Pro" while the membership that includes it is set to end. The end date comes from
   * State, never from the client. Nothing is charged now; the first charge is on that date. A PUT: calling
   * it again updates the billing period or token.
   */
  async continueAfterMembership(
    userId: string,
    tier: SubscriptionTier,
    input: { billingPeriod: ProBillingPeriod; paymentToken?: string },
    idempotencyKey: string,
  ): Promise<void> {
    if (!this.provider) throw new ProRequestError(503, 'PAYMENTS_NOT_CONFIGURED');
    if (!this.includesPro(tier)) throw new ProRequestError(409, 'MEMBERSHIP_NOT_ENDING');
    const now = this.now();
    const snapshot = await this.membership(userId);
    if (!this.includesPro(snapshot.tier) || !snapshot.endsAt || Date.parse(snapshot.endsAt) <= now.getTime()) {
      throw new ProRequestError(409, 'MEMBERSHIP_NOT_ENDING');
    }
    const existing = await this.store.read(userId, CONTINUATION_ROW, parseContinuation);
    if (existing && existing.value.status === 'STARTING') throw new ProRequestError(409, 'PRO_ALREADY_ACTIVE');
    const reuse = existing && existing.value.status === 'SCHEDULED';
    const doc: ContinuationDoc = {
      schemaVersion: 1,
      continuationId: reuse ? existing.value.continuationId : randomUUID(),
      userId,
      status: 'SCHEDULED',
      billingPeriod: input.billingPeriod,
      ...(input.paymentToken ? { paymentToken: input.paymentToken } : {}),
      startsAt: new Date(snapshot.endsAt).toISOString(),
      idempotencyKey: reuse ? existing.value.idempotencyKey : idempotencyKey,
      createdAt: reuse ? existing.value.createdAt : now.toISOString(),
      updatedAt: now.toISOString(),
    };
    try {
      await this.store.write(userId, CONTINUATION_ROW, doc, existing?.etag, doc.startsAt);
    } catch (error) {
      if (error instanceof RowExistsError || error instanceof RowChangedError) throw new ProRequestError(409, 'PRO_ALREADY_ACTIVE');
      throw error;
    }
    await this.notify(userId, 'PRO_CONTINUATION_SCHEDULED', `${doc.continuationId}:${doc.billingPeriod}:${doc.startsAt}`, {
      amountMinor: this.prices[doc.billingPeriod], at: doc.startsAt,
    });
    this.logger.info({ event: 'pro.continuation_scheduled', billingPeriod: doc.billingPeriod, updated: Boolean(reuse) });
  }

  async cancelContinuation(userId: string): Promise<void> {
    const existing = await this.store.read(userId, CONTINUATION_ROW, parseContinuation);
    if (!existing || existing.value.status === 'CANCELLED') return;
    if (existing.value.status === 'STARTED' || existing.value.status === 'STARTING') {
      throw new ProRequestError(409, 'CONTINUATION_ALREADY_STARTED');
    }
    const now = this.now();
    try {
      await this.store.replace(userId, CONTINUATION_ROW, { ...existing.value, status: 'CANCELLED', updatedAt: now.toISOString() }, existing.etag);
    } catch (error) {
      if (error instanceof RowChangedError) throw new ProRequestError(409, 'CONTINUATION_ALREADY_STARTED');
      throw error;
    }
    await this.notify(userId, 'PRO_CONTINUATION_CANCELLED', `${existing.value.continuationId}:cancelled`);
    this.logger.info({ event: 'pro.continuation_cancelled', by: 'member' });
  }

  async dismissNotice(userId: string, noticeId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(noticeId)) return;
    await this.store.delete(userId, `${NOTICE_PREFIX}${noticeId}`);
  }

  // ── Membership handover ───────────────────────────────────────────────────

  /**
   * State is activating a membership that includes Pro. Settle the member's Pro subscription, then confirm
   * so State can finalize the membership. Idempotent: a redelivered event changes nothing and confirms again.
   */
  async handleHandover(userId: string, activationId: string, eventId: string): Promise<'settled' | 'duplicate'> {
    const eventRow = `${EVENT_PREFIX}${shortHash(eventId)}`;
    const seen = await this.store.read(userId, eventRow, (v) => v);
    if (seen) {
      await this.directory.confirmProHandover(userId, activationId);
      return 'duplicate';
    }
    const now = this.now();
    await this.settleSubscriptionForHandover(userId, activationId, now);
    await this.cancelContinuationForHandover(userId, now);
    const handover = await this.store.read(userId, HANDOVER_ROW, parseHandover);
    await this.store.write(userId, HANDOVER_ROW, { schemaVersion: 1, activationId, at: now.toISOString() } satisfies HandoverDoc, handover?.etag)
      .catch((error: unknown) => {
        if (!(error instanceof RowChangedError || error instanceof RowExistsError)) throw error;
      });
    await this.directory.confirmProHandover(userId, activationId);
    await this.store.insert(userId, eventRow, { schemaVersion: 1, at: now.toISOString() }).catch((error: unknown) => {
      if (!(error instanceof RowExistsError)) throw error;
    });
    return 'settled';
  }

  private async settleSubscriptionForHandover(userId: string, activationId: string, now: Date): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await this.store.read(userId, SUBSCRIPTION_ROW, parseSubscription);
      if (!stored) return;
      const sub = stored.value;
      if (sub.status === 'ENDED') return;
      if (sub.status === 'PENDING') throw new ProRetryLaterError('A Pro purchase is being charged');
      if (sub.pausedByActivationId === activationId) return;
      let next: SubscriptionDoc;
      const notices: Array<[ProNoticeKind, string, { amountMinor?: number; at?: string }]> = [];
      if (sub.status === 'GRACE') {
        // A failed renewal: stop retrying; the membership covers Pro now. Nothing to refund.
        next = { ...sub, status: 'ENDED', endedReason: 'INCLUDED_IN_MEMBERSHIP', endedAt: now.toISOString(), autoRenew: false, updatedAt: now.toISOString() };
        notices.push(['PRO_PAUSED_FOR_MEMBERSHIP', `${sub.subscriptionId}:paused:${activationId}`, {}]);
      } else {
        next = {
          ...sub,
          pausedForMembership: true,
          pausedByActivationId: activationId,
          autoRenewBeforePause: sub.pausedForMembership ? sub.autoRenewBeforePause ?? sub.autoRenew : sub.autoRenew,
          autoRenew: false,
          updatedAt: now.toISOString(),
        };
        notices.push(['PRO_PAUSED_FOR_MEMBERSHIP', `${sub.subscriptionId}:paused:${activationId}`, { ...(sub.currentPeriodEnd ? { at: sub.currentPeriodEnd } : {}) }]);
        if (sub.billingPeriod === 'YEARLY' && sub.currentPeriodStart && !sub.refund) {
          const refund = yearlyRefund(sub.currentPeriodStart, sub.priceMinor, now.toISOString());
          if (refund.amountMinor > 0) {
            next.refund = { status: 'SCHEDULED', amountMinor: refund.amountMinor, dueAt: refund.dueAt };
            notices.push(['PRO_REFUND_SCHEDULED', `${sub.subscriptionId}:refund-scheduled`, { amountMinor: refund.amountMinor, at: refund.dueAt }]);
          }
        }
      }
      try {
        await this.store.replace(userId, SUBSCRIPTION_ROW, next, stored.etag, this.nextActionOf(next));
      } catch (error) {
        if (error instanceof RowChangedError) continue;
        throw error;
      }
      for (const [kind, key, extra] of notices) await this.notify(userId, kind, key, extra);
      this.logger.info({ event: 'pro.paused_for_membership', billingPeriod: sub.billingPeriod, refundScheduled: Boolean(next.refund) });
      return;
    }
    throw new ProRetryLaterError('Subscription kept changing');
  }

  private async cancelContinuationForHandover(userId: string, now: Date): Promise<void> {
    const stored = await this.store.read(userId, CONTINUATION_ROW, parseContinuation);
    if (!stored || stored.value.status !== 'SCHEDULED') return;
    try {
      await this.store.replace(userId, CONTINUATION_ROW, { ...stored.value, status: 'CANCELLED', updatedAt: now.toISOString() }, stored.etag);
    } catch (error) {
      if (error instanceof RowChangedError) throw new ProRetryLaterError('Continuation changed');
      throw error;
    }
    await this.notify(userId, 'PRO_CONTINUATION_CANCELLED', `${stored.value.continuationId}:membership-renewed`);
  }

  // ── Renewal job ───────────────────────────────────────────────────────────

  /** Processes due subscriptions and continuations. Returns how many rows were handled. */
  async runDue(limit = 100): Promise<number> {
    const now = this.now();
    const due = await this.store.due([SUBSCRIPTION_ROW, CONTINUATION_ROW], now, limit);
    let handled = 0;
    for (const row of due) {
      try {
        if (row.rowKey === SUBSCRIPTION_ROW) {
          if (await this.processSubscription(row.partitionKey, now)) handled += 1;
        } else if (await this.processContinuation(row.partitionKey, now)) handled += 1;
      } catch (error) {
        this.logger.error({ event: 'pro.job_failed', row: row.rowKey, errorType: errorType(error) });
      }
    }
    return handled;
  }

  /** Takes the row for this instance (lease on the ETag). Undefined when another instance has it. */
  private async claim<T extends { leaseUntil?: string; userId: string }>(
    stored: Stored<T>,
    rowKey: string,
    nextActionAt: string | undefined,
    now: Date,
  ): Promise<Stored<T> | undefined> {
    if (stored.value.leaseUntil && Date.parse(stored.value.leaseUntil) > now.getTime()) return undefined;
    const leased = { ...stored.value, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() };
    try {
      const etag = await this.store.replace(stored.value.userId, rowKey, leased, stored.etag, nextActionAt);
      return { value: leased, etag };
    } catch (error) {
      if (error instanceof RowChangedError) return undefined;
      throw error;
    }
  }

  private async defer<T extends { userId: string; leaseUntil?: string }>(stored: Stored<T>, rowKey: string, now: Date, why: string): Promise<void> {
    const { leaseUntil: _lease, ...rest } = stored.value;
    await this.store.replace(stored.value.userId, rowKey, rest, stored.etag, new Date(now.getTime() + RETRY_DEFER_MS).toISOString());
    this.logger.warn({ event: 'pro.job_deferred', row: rowKey, why });
  }

  private async processSubscription(partitionKey: string, now: Date): Promise<boolean> {
    const read = await this.store.readByPartition(partitionKey, SUBSCRIPTION_ROW, parseSubscription);
    if (!read) return false;
    const stored = await this.claim(read, SUBSCRIPTION_ROW, this.nextActionOf(read.value), now);
    if (!stored) return false;
    const sub = stored.value;

    if (sub.status === 'PENDING') {
      await this.settlePending(stored, now, 'job');
      return true;
    }
    if (sub.status !== 'ACTIVE' && sub.status !== 'GRACE') {
      await this.finish(stored, { ...sub }, now);
      return true;
    }
    if (sub.refund?.status === 'SCHEDULED' && Date.parse(sub.refund.dueAt) <= now.getTime()) {
      return this.processRefund(stored, now);
    }
    const periodEnd = sub.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : 0;
    if (now.getTime() < periodEnd) {
      await this.finish(stored, { ...sub }, now);
      return false;
    }

    // The paid period is over.
    let current = sub;
    if (current.pausedForMembership) {
      const snapshot = await this.membershipOrUndefined(sub.userId);
      if (!snapshot) {
        await this.defer(stored, SUBSCRIPTION_ROW, now, 'membership_unavailable');
        return true;
      }
      if (this.includesPro(snapshot.tier)) {
        await this.finish(stored, { ...current, status: 'ENDED', endedReason: 'INCLUDED_IN_MEMBERSHIP', endedAt: now.toISOString(), autoRenew: false }, now);
        this.logger.info({ event: 'pro.ended', reason: 'INCLUDED_IN_MEMBERSHIP' });
        return true;
      }
      // The membership went away during the paid period: Pro carries on as the member had it.
      current = {
        ...current, pausedForMembership: false, autoRenew: current.autoRenewBeforePause ?? false,
      };
      delete current.pausedByActivationId;
      delete current.autoRenewBeforePause;
      await this.notify(sub.userId, 'PRO_RESUMED', `${sub.subscriptionId}:resumed:${sub.periodIndex}`);
    }
    if (!current.autoRenew) {
      const reason: ProEndedReason = current.status === 'GRACE' ? 'PAYMENT_FAILED' : 'CANCELLED';
      await this.finish(stored, { ...current, status: 'ENDED', endedReason: reason, endedAt: now.toISOString() }, now);
      await this.notify(sub.userId, 'PRO_ENDED', `${sub.subscriptionId}:ended:${sub.periodIndex}`, { at: sub.currentPeriodEnd! });
      this.logger.info({ event: 'pro.ended', reason });
      return true;
    }
    if (current.status === 'GRACE' && current.retryAt && now.getTime() < Date.parse(current.retryAt)) {
      await this.finish(stored, current, now);
      return false;
    }
    return this.renew({ ...stored, value: current }, now);
  }

  private async renew(stored: Stored<SubscriptionDoc>, now: Date): Promise<boolean> {
    const sub = stored.value;
    // The rule: never renew Pro for a member whose membership covers it. State decides, not the token.
    const snapshot = await this.membershipOrUndefined(sub.userId);
    if (!snapshot) {
      await this.defer(stored, SUBSCRIPTION_ROW, now, 'membership_unavailable');
      return true;
    }
    if (this.includesPro(snapshot.tier)) {
      await this.finish(stored, { ...sub, status: 'ENDED', endedReason: 'INCLUDED_IN_MEMBERSHIP', endedAt: now.toISOString(), autoRenew: false }, now);
      await this.notify(sub.userId, 'PRO_ENDED', `${sub.subscriptionId}:included:${sub.periodIndex}`);
      this.logger.info({ event: 'pro.renewal_skipped', reason: 'INCLUDED_IN_MEMBERSHIP' });
      return true;
    }
    const attempt = sub.renewalAttempts + 1;
    let result: ProChargeResult;
    try {
      result = await this.charge(sub, 'RENEWAL', sub.periodIndex + 1, attempt);
    } catch (error) {
      if (error instanceof ProPaymentUnavailableError) {
        await this.defer(stored, SUBSCRIPTION_ROW, now, 'provider_unavailable');
        return true;
      }
      throw error;
    }
    const oldEnd = sub.currentPeriodEnd!;
    if (result.outcome === 'SUCCEEDED') {
      // The period keeps its anniversary, also when the charge succeeded during grace.
      const start = oldEnd;
      const end = addMonths(start, periodMonths(sub.billingPeriod));
      const next: SubscriptionDoc = {
        ...sub, status: 'ACTIVE', periodIndex: sub.periodIndex + 1, currentPeriodStart: start, currentPeriodEnd: end,
        renewalAttempts: 0, transactionId: result.transactionId,
      };
      delete next.graceUntil;
      delete next.retryAt;
      delete next.refund;
      await this.finish(stored, next, now);
      await this.notify(sub.userId, 'PRO_RENEWED', `${sub.subscriptionId}:renewed:${next.periodIndex}`, { amountMinor: sub.priceMinor, at: end });
      this.logger.info({ event: 'pro.renewed', billingPeriod: sub.billingPeriod, attempt });
      return true;
    }
    const graceUntil = sub.graceUntil ?? new Date(Date.parse(oldEnd) + GRACE_DAYS * DAY).toISOString();
    if (attempt > GRACE_DAYS || now.getTime() >= Date.parse(graceUntil)) {
      await this.finish(stored, { ...sub, status: 'ENDED', endedReason: 'PAYMENT_FAILED', endedAt: now.toISOString(), autoRenew: false, renewalAttempts: attempt }, now);
      await this.notify(sub.userId, 'PRO_ENDED', `${sub.subscriptionId}:payment-failed:${sub.periodIndex}`);
      this.logger.info({ event: 'pro.ended', reason: 'PAYMENT_FAILED', attempt });
      return true;
    }
    const retryAt = new Date(Math.min(now.getTime() + DAY, Date.parse(graceUntil))).toISOString();
    await this.finish(stored, { ...sub, status: 'GRACE', graceUntil, retryAt, renewalAttempts: attempt }, now);
    if (attempt === 1) await this.notify(sub.userId, 'PRO_RENEWAL_FAILED', `${sub.subscriptionId}:renewal-failed:${sub.periodIndex}`, { at: graceUntil });
    this.logger.info({ event: 'pro.renewal_declined', attempt });
    return true;
  }

  private async processRefund(stored: Stored<SubscriptionDoc>, now: Date): Promise<boolean> {
    const sub = stored.value;
    const refund = sub.refund!;
    const snapshot = await this.membershipOrUndefined(sub.userId);
    if (!snapshot) {
      await this.defer(stored, SUBSCRIPTION_ROW, now, 'membership_unavailable');
      return true;
    }
    if (!this.includesPro(snapshot.tier)) {
      // The membership ended within the window: no refund, the yearly plan just continues.
      const next: SubscriptionDoc = {
        ...sub, pausedForMembership: false, autoRenew: sub.autoRenewBeforePause ?? sub.autoRenew,
        refund: { ...refund, status: 'CANCELLED' },
      };
      delete next.pausedByActivationId;
      delete next.autoRenewBeforePause;
      await this.finish(stored, next, now);
      await this.notify(sub.userId, 'PRO_REFUND_CANCELLED', `${sub.subscriptionId}:refund-cancelled`, { amountMinor: refund.amountMinor });
      this.logger.info({ event: 'pro.refund_cancelled' });
      return true;
    }
    if (!this.provider || !this.provider.capabilities.serverRefunds || !sub.transactionId) {
      // The rail cannot refund from the server (e.g. the App Store): an operator must. Never mark it issued.
      this.logger.error({ event: 'pro.refund_manual_required', provider: sub.provider });
      await this.defer(stored, SUBSCRIPTION_ROW, now, 'refund_not_supported');
      return true;
    }
    const key = `${LEDGER_PREFIX}refund:${sub.subscriptionId}:${sub.periodIndex}`;
    const ledger = await this.openLedger(sub, key, 'REFUND', sub.periodIndex, 1, refund.amountMinor, now);
    let refundId = ledger.value.providerRef;
    if (ledger.value.status !== 'SUCCEEDED') {
      try {
        refundId = (await this.provider.refund({
          idempotencyKey: `${sub.subscriptionId}:refund:${sub.periodIndex}`,
          userId: sub.userId,
          transactionId: sub.transactionId,
          amountMinor: refund.amountMinor,
          currency: sub.currency,
          reason: 'INCLUDED_IN_MEMBERSHIP',
        })).refundId;
      } catch (error) {
        if (error instanceof ProPaymentUnavailableError) {
          await this.defer(stored, SUBSCRIPTION_ROW, now, 'provider_unavailable');
          return true;
        }
        throw error;
      }
      await this.store.replace(sub.userId, key, { ...ledger.value, status: 'SUCCEEDED', providerRef: refundId, updatedAt: now.toISOString() }, ledger.etag);
    }
    const next: SubscriptionDoc = {
      ...sub, status: 'ENDED', endedReason: 'REFUNDED', endedAt: now.toISOString(), autoRenew: false,
      currentPeriodEnd: refund.dueAt,
      refund: { ...refund, status: 'ISSUED', issuedAt: now.toISOString(), ...(refundId ? { refundId } : {}) },
    };
    await this.finish(stored, next, now);
    await this.notify(sub.userId, 'PRO_REFUND_ISSUED', `${sub.subscriptionId}:refund-issued`, { amountMinor: refund.amountMinor, at: now.toISOString() });
    this.logger.info({ event: 'pro.refund_issued' });
    return true;
  }

  private async processContinuation(partitionKey: string, now: Date): Promise<boolean> {
    const read = await this.store.readByPartition(partitionKey, CONTINUATION_ROW, parseContinuation);
    if (!read) return false;
    const cont = read.value;
    const dueAt = cont.startNow ? now.getTime() : Date.parse(cont.startsAt);
    if ((cont.status !== 'SCHEDULED' && cont.status !== 'STARTING') || dueAt > now.getTime()) {
      // Not due (any more): clear or move the job marker.
      await this.store.replace(cont.userId, CONTINUATION_ROW, cont, read.etag,
        cont.status === 'SCHEDULED' ? cont.startsAt : undefined).catch(() => undefined);
      return false;
    }
    const stored = await this.claim(read, CONTINUATION_ROW, now.toISOString(), now);
    if (!stored) return false;

    if (cont.status === 'SCHEDULED') {
      const snapshot = await this.membershipOrUndefined(cont.userId);
      if (!snapshot) {
        await this.defer(stored, CONTINUATION_ROW, now, 'membership_unavailable');
        return true;
      }
      const subscription = await this.store.read(cont.userId, SUBSCRIPTION_ROW, parseSubscription);
      const alreadyPro = subscription && this.entitles(subscription.value, now) && !subscription.value.pausedForMembership;
      if (this.includesPro(snapshot.tier) || alreadyPro) {
        // Re-subscribed to the membership, or a paid plan carries on: nothing to start, nothing charged.
        await this.endContinuation(stored, 'CANCELLED', now);
        await this.notify(cont.userId, 'PRO_CONTINUATION_CANCELLED', `${cont.continuationId}:not-needed`);
        this.logger.info({ event: 'pro.continuation_not_needed', reason: alreadyPro ? 'PRO_ACTIVE' : 'MEMBERSHIP_ACTIVE' });
        return true;
      }
      if (subscription?.value.status === 'PENDING') {
        await this.defer(stored, CONTINUATION_ROW, now, 'purchase_pending');
        return true;
      }
      // Start: remember the subscription id first, so a crash mid-way resumes the same subscription.
      const starting: ContinuationDoc = { ...stored.value, status: 'STARTING', subscriptionId: randomUUID(), updatedAt: now.toISOString() };
      const etag = await this.store.replace(cont.userId, CONTINUATION_ROW, starting, stored.etag, now.toISOString());
      return this.startContinuation({ value: starting, etag }, now);
    }
    return this.startContinuation(stored, now);
  }

  /**
   * STARTING: create the subscription it names (a PENDING row keyed by the kept-Pro request) unless it
   * exists, charge its first period (idempotent), then mark the continuation STARTED.
   */
  private async startContinuation(stored: Stored<ContinuationDoc>, now: Date): Promise<boolean> {
    const cont = stored.value;
    if (!this.provider) {
      await this.defer(stored, CONTINUATION_ROW, now, 'payments_not_configured');
      return true;
    }
    let subscription = await this.store.read(cont.userId, SUBSCRIPTION_ROW, parseSubscription);
    if (!subscription || subscription.value.subscriptionId !== cont.subscriptionId) {
      if (subscription && (this.entitles(subscription.value, now) || subscription.value.status === 'PENDING')) {
        // The member bought Pro meanwhile: the kept plan is not needed.
        await this.endContinuation(stored, 'CANCELLED', now);
        await this.notify(cont.userId, 'PRO_CONTINUATION_CANCELLED', `${cont.continuationId}:not-needed`);
        return true;
      }
      const pending: SubscriptionDoc = {
        schemaVersion: 1, subscriptionId: cont.subscriptionId!, userId: cont.userId, status: 'PENDING',
        billingPeriod: cont.billingPeriod, priceMinor: this.prices[cont.billingPeriod], currency: this.currency,
        autoRenew: true, pausedForMembership: false, periodIndex: 0, renewalAttempts: 0, provider: this.provider.name,
        ...(cont.paymentToken ? { paymentToken: cont.paymentToken } : {}),
        purchaseKey: cont.idempotencyKey, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      };
      const etag = await this.store.write(cont.userId, SUBSCRIPTION_ROW, pending, subscription?.etag, now.toISOString());
      subscription = { value: pending, etag };
    }
    const result = subscription.value.status === 'PENDING'
      ? await this.settlePending(subscription, now, 'job')
      : subscription.value;
    if (result.status === 'PENDING') {
      await this.defer(stored, CONTINUATION_ROW, now, 'provider_unavailable');
      return true;
    }
    await this.endContinuation(stored, 'STARTED', now);
    if (result.status === 'ACTIVE') {
      await this.notify(cont.userId, 'PRO_CONTINUATION_STARTED', `${cont.continuationId}:started`, {
        amountMinor: result.priceMinor, at: result.currentPeriodEnd!,
      });
    }
    this.logger.info({ event: 'pro.continuation_started', outcome: result.status });
    return true;
  }

  private async endContinuation(stored: Stored<ContinuationDoc>, status: 'STARTED' | 'CANCELLED', now: Date): Promise<void> {
    const { leaseUntil: _lease, ...rest } = stored.value;
    await this.store.replace(stored.value.userId, CONTINUATION_ROW, { ...rest, status, updatedAt: now.toISOString() }, stored.etag);
  }

  /** Writes the job's result and releases the lease; `nextActionAt` follows from the new state. */
  private async finish(stored: Stored<SubscriptionDoc>, next: SubscriptionDoc, now: Date, nextActionAt?: string): Promise<void> {
    const { leaseUntil: _lease, ...rest } = { ...next, updatedAt: now.toISOString() };
    await this.store.replace(stored.value.userId, SUBSCRIPTION_ROW, rest, stored.etag, nextActionAt ?? this.nextActionOf(rest));
  }

  /** When the job must look at this subscription next (undefined: never). */
  private nextActionOf(sub: SubscriptionDoc): string | undefined {
    if (sub.status === 'PENDING') return sub.updatedAt;
    if (sub.status !== 'ACTIVE' && sub.status !== 'GRACE') return undefined;
    const times: number[] = [];
    if (sub.refund?.status === 'SCHEDULED') times.push(Date.parse(sub.refund.dueAt));
    if (sub.status === 'GRACE') {
      times.push(Date.parse(sub.retryAt ?? sub.graceUntil ?? sub.updatedAt));
    } else if (sub.currentPeriodEnd) {
      times.push(Date.parse(sub.currentPeriodEnd));
    }
    return times.length > 0 ? new Date(Math.min(...times)).toISOString() : undefined;
  }

  // ── Money ─────────────────────────────────────────────────────────────────

  /** One charge attempt: ledger row first (insert-if-absent), then the provider with a derived key. */
  private async charge(sub: SubscriptionDoc, kind: 'PURCHASE' | 'RENEWAL', periodIndex: number, attempt: number): Promise<ProChargeResult> {
    if (!this.provider) throw new ProPaymentUnavailableError('No payment provider');
    const now = this.now();
    const key = `${LEDGER_PREFIX}charge:${sub.subscriptionId}:${periodIndex}:${attempt}`;
    const ledger = await this.openLedger(sub, key, 'CHARGE', periodIndex, attempt, sub.priceMinor, now);
    if (ledger.value.status === 'SUCCEEDED' && ledger.value.providerRef) {
      return { outcome: 'SUCCEEDED', transactionId: ledger.value.providerRef };
    }
    if (ledger.value.status === 'DECLINED') return { outcome: 'DECLINED' };
    const result = await this.provider.charge({
      idempotencyKey: `${sub.subscriptionId}:${periodIndex}:${attempt}`,
      userId: sub.userId,
      kind,
      billingPeriod: sub.billingPeriod,
      amountMinor: sub.priceMinor,
      currency: sub.currency,
      ...(sub.paymentToken ? { paymentToken: sub.paymentToken } : {}),
      ...(kind === 'RENEWAL' && sub.transactionId ? { transactionId: sub.transactionId } : {}),
    });
    await this.store.replace(sub.userId, key, {
      ...ledger.value,
      status: result.outcome,
      ...(result.outcome === 'SUCCEEDED' ? { providerRef: result.transactionId } : {}),
      updatedAt: now.toISOString(),
    } satisfies LedgerDoc, ledger.etag);
    return result;
  }

  private async openLedger(
    sub: SubscriptionDoc, key: string, kind: LedgerDoc['kind'], periodIndex: number, attempt: number, amountMinor: number, now: Date,
  ): Promise<Stored<LedgerDoc>> {
    const doc: LedgerDoc = {
      schemaVersion: 1, kind, subscriptionId: sub.subscriptionId, periodIndex, attempt, amountMinor, currency: sub.currency,
      status: 'PENDING', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    try {
      const etag = await this.store.insert(sub.userId, key, doc);
      return { value: doc, etag };
    } catch (error) {
      if (!(error instanceof RowExistsError)) throw error;
      const existing = await this.store.read(sub.userId, key, parseLedger);
      if (!existing) throw new ProPaymentUnavailableError('Ledger row vanished');
      return existing;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async membership(userId: string) {
    try {
      return await this.directory.get(userId);
    } catch (error) {
      if (error instanceof MembershipUnavailableError) throw new ProRequestError(503, 'PRO_TEMPORARILY_UNAVAILABLE');
      throw error;
    }
  }

  private async membershipOrUndefined(userId: string) {
    try {
      return await this.directory.get(userId);
    } catch (error) {
      if (error instanceof MembershipUnavailableError) return undefined;
      throw error;
    }
  }

  /** Records a notice once per `key` (insert-if-absent): retries and redeliveries never repeat one. */
  async notify(userId: string, kind: ProNoticeKind, key: string, extra: { amountMinor?: number; at?: string } = {}): Promise<void> {
    const noticeId = shortHash(`${kind}:${key}`);
    const doc: NoticeDoc = {
      schemaVersion: 1, noticeId, kind, createdAt: this.now().toISOString(),
      ...(extra.amountMinor !== undefined ? { amountMinor: extra.amountMinor, currency: this.currency } : {}),
      ...(extra.at ? { at: extra.at } : {}),
    };
    try {
      await this.store.insert(userId, `${NOTICE_PREFIX}${noticeId}`, doc);
    } catch (error) {
      if (error instanceof RowExistsError) return;
      // A notice is never worth failing the money movement it describes.
      this.logger.warn({ event: 'pro.notice_failed', kind, errorType: errorType(error) });
    }
  }

  /**
   * Account deletion: removes the member's Pro rows. Charge and refund ledger rows stay for accounting;
   * they hold amounts and opaque ids only (no member id). Nothing can renew afterwards: the subscription
   * and continuation rows are gone, so the job never finds them.
   */
  async eraseUser(userId: string): Promise<number> {
    let removed = 0;
    for (const rowKey of [SUBSCRIPTION_ROW, CONTINUATION_ROW, HANDOVER_ROW]) {
      await this.store.delete(userId, rowKey);
      removed += 1;
    }
    for (const prefix of [NOTICE_PREFIX, EVENT_PREFIX, 'usage:']) {
      for (const row of await this.store.list(userId, prefix, (v) => v)) {
        await this.store.delete(userId, row.rowKey);
        removed += 1;
      }
    }
    return removed;
  }
}
