import { MembershipEndReason, type OneHook } from 'onehook-api-client';
import { resolveSubscriptionTier } from 'onehook-api-client/membership';
import { createOneHookApiClient, httpStatusOf } from './oneHookApiClient';
import type { RequestSigner } from './oneHookDataClient';
import {
  MembershipUnavailableError,
  type MembershipDirectory,
  type MembershipEndReason as EndReason,
  type MembershipSnapshot,
} from './membershipDirectory';

/**
 * The membership directory over State's IAM-only operations (OneHookBackend state.smithy), through the
 * generated onehook-api-client (./oneHookApiClient.ts), SigV4-signed with OneHook-MrOneHook-<stage>-Role:
 *
 *   GetInternalMembership         GET  /state/internal/users/{targetUserId}/membership
 *   ConfirmMrOneHookProHandover   POST /state/internal/users/{targetUserId}/mr-onehook-pro-handovers/{activationId}/confirmation
 *
 * State answers epoch seconds; the directory speaks ISO-8601, like the rest of Mr OneHook Pro. Fails
 * closed: any signing, network, HTTP or shape problem throws {@link MembershipUnavailableError}, so a caller
 * never mistakes "could not ask" for "not a member" (and never charges on it).
 */
const END_REASONS: ReadonlySet<string> = new Set(Object.values(MembershipEndReason));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function iso(epochSeconds: unknown): string | undefined {
  return Number.isSafeInteger(epochSeconds) && (epochSeconds as number) > 0
    ? new Date((epochSeconds as number) * 1000).toISOString()
    : undefined;
}

function unavailable(what: string, error: unknown): MembershipUnavailableError {
  const status = httpStatusOf(error);
  return new MembershipUnavailableError(status !== undefined
    ? `${what} returned ${status}`
    : `${what} failed: ${error instanceof Error ? error.name : 'unknown error'}`);
}

export class StateMembershipClient implements MembershipDirectory {
  private readonly api: OneHook;

  constructor(baseUrl: string, signer: RequestSigner, timeoutMs: number, fetchImpl: typeof fetch = fetch) {
    this.api = createOneHookApiClient({ baseUrl, signer, timeoutMs, fetchImpl });
  }

  async get(userId: string): Promise<MembershipSnapshot> {
    if (!userId || userId.length > 256) throw new MembershipUnavailableError('Invalid member id');
    let body: unknown;
    try {
      body = await this.api.getInternalMembership({ targetUserId: userId });
    } catch (error) {
      throw unavailable('Membership read', error);
    }
    if (!isRecord(body) || body.userId !== userId || typeof body.tier !== 'string') {
      throw new MembershipUnavailableError('Invalid membership body');
    }
    const endsAt = iso(body.endsAt);
    let lastEnded: MembershipSnapshot['lastEnded'];
    if (body.lastEnded !== undefined) {
      const ended = body.lastEnded;
      const at = isRecord(ended) ? iso(ended.at) : undefined;
      if (!isRecord(ended) || !at || typeof ended.reason !== 'string' || !END_REASONS.has(ended.reason)
        || typeof ended.tier !== 'string') {
        throw new MembershipUnavailableError('Invalid membership end');
      }
      lastEnded = { at, reason: ended.reason as EndReason, tier: resolveSubscriptionTier(ended.tier) };
    }
    return {
      tier: resolveSubscriptionTier(body.tier),
      ...(endsAt ? { endsAt } : {}),
      ...(lastEnded ? { lastEnded } : {}),
    };
  }

  async confirmProHandover(userId: string, activationId: string): Promise<void> {
    let body: unknown;
    try {
      body = await this.api.confirmMrOneHookProHandover({ targetUserId: userId, activationId });
    } catch (error) {
      throw unavailable('Handover confirmation', error);
    }
    // APPLIED, ALREADY_APPLIED and NOT_PENDING all mean State holds nothing more for this activation.
    if (!isRecord(body) || body.activationId !== activationId || typeof body.outcome !== 'string') {
      throw new MembershipUnavailableError('Invalid handover confirmation body');
    }
  }
}
