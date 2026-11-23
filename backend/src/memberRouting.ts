import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { SubscriptionTier } from 'onehook-api-client';
import type { ContextualFeatureConfig } from './contextConfig';
import type { ProEntitlement, ProSubscriptionService } from './proSubscriptionService';
import { isUuid } from './contextTypes';

/** Shared pieces of the member routes (chat, sessions, attachments, Mr OneHook Pro). */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/** In-memory fixed-window limit per member (per instance). Answers 429 `RATE_LIMITED`. */
export function createPrincipalRateLimiter(
  keyForRequest: (req: Request) => string | undefined,
  limit: number,
  windowMs = 60_000,
  maxEntries = 10_000,
) {
  const entries = new Map<string, RateLimitEntry>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyForRequest(req);
    if (!key) {
      res.status(401).json({ error: 'AUTH_REQUIRED' });
      return;
    }
    const now = Date.now();
    for (const [entryKey, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(entryKey);
    }
    if (entries.size >= maxEntries && !entries.has(key)) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (oldestKey) entries.delete(oldestKey);
    }
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    existing.count += 1;
    if (existing.count > limit) {
      res.status(429).json({ error: 'RATE_LIMITED' });
      return;
    }
    next();
  };
}

/** A UUID `Idempotency-Key`, else undefined. */
export function idempotencyKeyOf(req: Request): string | undefined {
  const key = req.get('idempotency-key');
  return key && isUuid(key) ? key : undefined;
}

export function requestIdFor(req: Request): string {
  return idempotencyKeyOf(req) ?? randomUUID();
}

/** The member's Mr OneHook plan: membership first (no lookup), then the Pro table when there is one. */
export async function resolveEntitlement(
  config: ContextualFeatureConfig,
  pro: ProSubscriptionService | undefined,
  subject: string,
  tier: SubscriptionTier,
): Promise<ProEntitlement> {
  if (pro) return pro.entitlement(subject, tier);
  return config.pro.includedTiers.includes(tier)
    ? { plan: 'PRO', source: 'MEMBERSHIP' }
    : { plan: 'FREE', source: 'NONE' };
}

export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}
