import type { NextFunction, Request, Response, Router } from 'express';
import type { ChatSessionPlanPolicy, ContextualFeatureConfig } from './contextConfig';
import type { ContextualServices } from './contextRoutes';
import type {
  GetMrOneHookProResponseContent,
  MrOneHookPlan,
  ProBillingPeriod,
  ProNotice,
  ProSubscription,
} from './generated/mrOneHookModels';
import { idempotencyKeyOf, pathParam } from './memberRouting';
import { ProStoreUnavailableError, RowChangedError } from './proStore';
import {
  ProRequestError,
  type ContinuationDoc,
  type NoticeDoc,
  type ProEntitlement,
  type ProMemberState,
  type SubscriptionDoc,
} from './proSubscriptionService';
import { nextMonthStart } from './attachmentUsage';

/**
 * Mr OneHook Pro routes (member token, the shared 20 requests per minute):
 *
 *   GET    /api/member/mr-onehook-pro                          plan, subscription, offers, limits, notices
 *   POST   /api/member/mr-onehook-pro/subscription             buy (Idempotency-Key required)
 *   PUT    /api/member/mr-onehook-pro/subscription/auto-renew  { autoRenew }
 *   PUT    /api/member/mr-onehook-pro/continuation             "Keep Mr OneHook Pro" after the membership
 *   DELETE /api/member/mr-onehook-pro/continuation             withdraw it before it starts
 *   DELETE /api/member/mr-onehook-pro/notices/:noticeId        dismiss a notice
 *
 * While `MR_ONEHOOK_PRO_ENABLED` is off they answer 404 `ENDPOINT_NOT_FOUND` (plans still apply: a
 * membership that includes Pro is Pro). Every answer is a fresh status view, so the app redraws from it.
 */
export interface ProRouteDeps {
  config: ContextualFeatureConfig;
  services: ContextualServices;
  authenticateUser: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  userRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  planOf: (req: Request) => Promise<ProEntitlement>;
  policyOf: (plan: MrOneHookPlan) => ChatSessionPlanPolicy | undefined;
  freeDailyMessages: number;
}

export function registerUnavailableProRoutes(router: Router, status: number, error: string): void {
  const answer = (_req: Request, res: Response) => {
    res.status(status).json({ error });
  };
  router.get('/api/member/mr-onehook-pro', answer);
  router.post('/api/member/mr-onehook-pro/subscription', answer);
  router.put('/api/member/mr-onehook-pro/subscription/auto-renew', answer);
  router.put('/api/member/mr-onehook-pro/continuation', answer);
  router.delete('/api/member/mr-onehook-pro/continuation', answer);
  router.delete('/api/member/mr-onehook-pro/notices/:noticeId', answer);
}

function subscriptionView(sub: SubscriptionDoc): ProSubscription {
  const nextChargeAt = sub.autoRenew && (sub.status === 'ACTIVE' || sub.status === 'GRACE')
    ? (sub.status === 'GRACE' ? sub.retryAt : sub.currentPeriodEnd)
    : undefined;
  return {
    status: sub.status,
    billingPeriod: sub.billingPeriod,
    autoRenew: sub.autoRenew,
    priceMinor: sub.priceMinor,
    currency: sub.currency,
    pausedForMembership: sub.pausedForMembership,
    ...(sub.currentPeriodStart ? { currentPeriodStart: sub.currentPeriodStart } : {}),
    ...(sub.currentPeriodEnd ? { currentPeriodEnd: sub.status === 'GRACE' && sub.graceUntil ? sub.graceUntil : sub.currentPeriodEnd } : {}),
    ...(nextChargeAt ? { nextChargeAt } : {}),
    ...(sub.refund
      ? {
          refund: {
            status: sub.refund.status,
            amountMinor: sub.refund.amountMinor,
            currency: sub.currency,
            dueAt: sub.refund.dueAt,
            ...(sub.refund.issuedAt ? { issuedAt: sub.refund.issuedAt } : {}),
          },
        }
      : {}),
    ...(sub.endedReason ? { endedReason: sub.endedReason } : {}),
    createdAt: sub.createdAt,
  };
}

function continuationView(cont: ContinuationDoc, priceMinor: number, currency: string): ProSubscription {
  return {
    status: 'SCHEDULED',
    billingPeriod: cont.billingPeriod,
    autoRenew: true,
    priceMinor,
    currency,
    pausedForMembership: false,
    scheduledStartAt: cont.startsAt,
    nextChargeAt: cont.startsAt,
    createdAt: cont.createdAt,
  };
}

function noticeView(notice: NoticeDoc): ProNotice {
  return {
    noticeId: notice.noticeId,
    kind: notice.kind,
    createdAt: notice.createdAt,
    ...(notice.amountMinor !== undefined ? { amountMinor: notice.amountMinor } : {}),
    ...(notice.currency ? { currency: notice.currency } : {}),
    ...(notice.at ? { at: notice.at } : {}),
  };
}

function parsePeriod(value: unknown): ProBillingPeriod | undefined {
  return value === 'MONTHLY' || value === 'YEARLY' ? value : undefined;
}

function parseToken(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length >= 1 && value.length <= 16_384 ? value : null;
}

export function registerProRoutes(router: Router, deps: ProRouteDeps): void {
  const { config, services, authenticateUser, userRateLimit, policyOf, freeDailyMessages } = deps;
  const pro = services.pro;

  /** 404 while Pro is off; 503 when it is on but cannot run. */
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    if (!config.pro.enabled) {
      res.status(404).json({ error: 'ENDPOINT_NOT_FOUND' });
      return;
    }
    if (!pro || !config.pro.ready) {
      res.status(503).json({ error: 'PRO_TEMPORARILY_UNAVAILABLE' });
      return;
    }
    next();
  };

  async function view(req: Request): Promise<GetMrOneHookProResponseContent> {
    const subject = req.auth!.subject;
    const state: ProMemberState = await pro!.memberState(subject, req.auth!.membership);
    const plan = state.entitlement.plan;
    const policy = policyOf(plan);
    const now = new Date();
    let subscription: ProSubscription | undefined;
    const scheduled = state.continuation && (state.continuation.status === 'SCHEDULED' || state.continuation.status === 'STARTING');
    const subscriptionLive = state.subscription && state.subscription.status !== 'ENDED';
    if (scheduled && !subscriptionLive) {
      subscription = continuationView(state.continuation!, config.pro.prices[state.continuation!.billingPeriod], config.pro.currency);
    } else if (state.subscription) {
      subscription = subscriptionView(state.subscription);
    }
    let attachmentUsage: GetMrOneHookProResponseContent['attachmentUsage'];
    if (plan === 'PRO' && services.attachments && config.attachments.ready) {
      const budget = state.entitlement.source === 'MEMBERSHIP'
        ? config.attachments.monthlyBudgetMinor.membership
        : config.attachments.monthlyBudgetMinor.subscription;
      const usedPercent = await services.attachments.usage.usedPercent(subject, budget).catch(() => undefined);
      if (usedPercent !== undefined) attachmentUsage = { usedPercent, warning: usedPercent >= 80, resetsAt: nextMonthStart(now) };
    }
    return {
      plan,
      source: state.entitlement.source,
      ...(subscription ? { subscription } : {}),
      canPurchase: state.canPurchase,
      offers: pro!.offers(),
      limits: {
        ...(plan === 'FREE' ? { dailyMessages: freeDailyMessages } : {}),
        maxSessions: policy?.maxSessions ?? 0,
        attachmentsAllowed: plan === 'PRO' && Boolean(services.attachments) && config.attachments.ready,
        maxAttachmentBytes: config.attachments.maxBytes,
        maxAttachmentsPerMessage: config.attachments.maxPerMessage,
      },
      ...(attachmentUsage ? { attachmentUsage } : {}),
      notices: state.notices.map(noticeView),
    };
  }

  /** Runs an action, then answers the status view; maps the service's errors to the contract. */
  async function act(req: Request, res: Response, action: () => Promise<void>, answer: 'view' | 204 = 'view'): Promise<void> {
    try {
      await action();
      if (answer === 204) res.status(204).send();
      else res.json(await view(req));
    } catch (error) {
      if (error instanceof ProRequestError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      if (error instanceof ProStoreUnavailableError || error instanceof RowChangedError) {
        res.status(503).json({ error: 'PRO_TEMPORARILY_UNAVAILABLE' });
        return;
      }
      console.error('Mr OneHook Pro request failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      res.status(503).json({ error: 'PRO_TEMPORARILY_UNAVAILABLE' });
    }
  }

  router.get('/api/member/mr-onehook-pro', authenticateUser, userRateLimit, gate, async (req, res): Promise<void> => {
    await act(req, res, async () => undefined);
  });

  router.post('/api/member/mr-onehook-pro/subscription', authenticateUser, userRateLimit, gate, async (req, res): Promise<void> => {
    const key = idempotencyKeyOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const billingPeriod = parsePeriod(body.billingPeriod);
    const paymentToken = parseToken(body.paymentToken);
    if (!key || !billingPeriod || paymentToken === null) {
      res.status(400).json({ error: 'INVALID_PRO_REQUEST' });
      return;
    }
    await act(req, res, () => pro!.purchase(req.auth!.subject, req.auth!.membership, {
      billingPeriod, ...(paymentToken ? { paymentToken } : {}),
    }, key));
  });

  router.put('/api/member/mr-onehook-pro/subscription/auto-renew', authenticateUser, userRateLimit, gate, async (req, res): Promise<void> => {
    const autoRenew = (req.body as Record<string, unknown> | undefined)?.autoRenew;
    if (typeof autoRenew !== 'boolean') {
      res.status(400).json({ error: 'INVALID_PRO_REQUEST' });
      return;
    }
    await act(req, res, () => pro!.setAutoRenew(req.auth!.subject, autoRenew));
  });

  router.put('/api/member/mr-onehook-pro/continuation', authenticateUser, userRateLimit, gate, async (req, res): Promise<void> => {
    const key = idempotencyKeyOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const billingPeriod = parsePeriod(body.billingPeriod);
    const paymentToken = parseToken(body.paymentToken);
    if (!key || !billingPeriod || paymentToken === null) {
      res.status(400).json({ error: 'INVALID_PRO_REQUEST' });
      return;
    }
    await act(req, res, () => pro!.continueAfterMembership(req.auth!.subject, req.auth!.membership, {
      billingPeriod, ...(paymentToken ? { paymentToken } : {}),
    }, key));
  });

  router.delete('/api/member/mr-onehook-pro/continuation', authenticateUser, userRateLimit, gate, async (req, res): Promise<void> => {
    await act(req, res, () => pro!.cancelContinuation(req.auth!.subject), 204);
  });

  router.delete('/api/member/mr-onehook-pro/notices/:noticeId', authenticateUser, userRateLimit, gate, async (req, res): Promise<void> => {
    await act(req, res, () => pro!.dismissNotice(req.auth!.subject, pathParam(req, 'noticeId')), 204);
  });
}
