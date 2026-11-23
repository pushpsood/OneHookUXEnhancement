import type { MembershipEndReason, SubscriptionTier } from 'onehook-api-client';

/**
 * What Mr OneHook Pro needs from the OneHook membership (State, OneHookBackend), and nothing more.
 *
 * Chat requests never call it: a member whose verified Cognito token carries a tier that includes Pro is
 * Pro, with no lookup. It is used only where no token is available or the token may be stale:
 *  - the renewal job, before every Pro charge or refund ("is this member covered by the membership now?");
 *  - "Keep Mr OneHook Pro", to read when the membership ends (never trusted from the client);
 *  - a purchase shortly after a handover, while the member's token may still show the old tier;
 *  - a member on a kept-Pro grace period, to apply the refund/chargeback exception;
 *  - confirming a Pro handover, after which State finalizes the membership upgrade.
 *
 * In production this is {@link StateMembershipClient} (./stateMembershipClient.ts) over State's IAM-only
 * GetInternalMembership and ConfirmMrOneHookProHandover. Without a State URL, {@link
 * unavailableMembershipDirectory} is used: every call fails, so nothing is charged or refunded, kept-Pro
 * requests answer 503 and handover events are retried (and reach the DLQ), which is the safe direction.
 */
export interface MembershipSnapshot {
  /** The effective tier now (billing tier, or an active operator override). */
  tier: SubscriptionTier;
  /** ISO-8601: the paid membership is set to end then (cancelled at period end). Absent when renewing. */
  endsAt?: string;
  /** The last time a paid membership ended, if it did (most recent first). */
  lastEnded?: { at: string; reason: MembershipEndReason; tier: SubscriptionTier };
}

/** How a membership tier ended (State's `MembershipEndReason`, from onehook-api-client). */
export type { MembershipEndReason };

/** Membership ends that do not earn free Pro until the original end date (the money was returned). */
export const NO_GRACE_END_REASONS: ReadonlySet<MembershipEndReason> = new Set(['REFUNDED', 'CHARGEBACK']);

export interface MembershipDirectory {
  get(userId: string): Promise<MembershipSnapshot>;
  /** Tells State that Mr OneHook settled the member's Pro subscription for this activation. Idempotent. */
  confirmProHandover(userId: string, activationId: string): Promise<void>;
}

/** The membership could not be read or confirmed. Never treat it as "not a member": retry later. */
export class MembershipUnavailableError extends Error {}

export const unavailableMembershipDirectory: MembershipDirectory = {
  get: async () => {
    throw new MembershipUnavailableError('No State API configured (ONEHOOK_DATA_API_URL)');
  },
  confirmProHandover: async () => {
    throw new MembershipUnavailableError('No State API configured (ONEHOOK_DATA_API_URL)');
  },
};
