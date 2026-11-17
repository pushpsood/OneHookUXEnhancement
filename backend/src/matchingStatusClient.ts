import type { RequestSigner } from './oneHookDataClient';

/**
 * Reads a member's matching mode from State before Mr OneHook uses matching data for them (chat-only
 * profiles, design §8.6).
 *
 * State's `GetInternalMatchingStatus` (`GET /state/internal/users/{targetUserId}/matching`), called through the
 * generated onehook-api-client (./oneHookApiClient.ts). It is IAM-only, on the same State API as the
 * AI-context route, so it is SigV4-signed with this service's federated role
 * (OneHook-MrOneHook-<stage>-Role). State answers `{userId, status: OFF | ON | ERASING, generation}`; an
 * unknown member reads as OFF.
 *
 * Fails closed: any signing, network, HTTP or shape problem throws {@link MatchingStatusUnavailableError},
 * so a caller can never mistake "could not ask" for ON.
 */

// State's matching status (state.smithy `MatchingMode` / `MatchingStatus`, from onehook-api-client).
export { MatchingMode } from 'onehook-api-client';
export type { MatchingStatus } from 'onehook-api-client';
import { MatchingMode, type MatchingStatus, type OneHook } from 'onehook-api-client';
import { createOneHookApiClient, httpStatusOf } from './oneHookApiClient';

export interface MatchingStatusReader {
  get(userId: string): Promise<MatchingStatus>;
}

export class MatchingStatusUnavailableError extends Error {}

const MODES = new Set<MatchingMode>(['OFF', 'ON', 'ERASING']);

export class MatchingStatusClient implements MatchingStatusReader {
  private readonly api: OneHook;

  constructor(baseUrl: string, signer: RequestSigner, timeoutMs: number, fetchImpl: typeof fetch = fetch) {
    this.api = createOneHookApiClient({ baseUrl, signer, timeoutMs, fetchImpl });
  }

  async get(userId: string): Promise<MatchingStatus> {
    if (!userId || userId.length > 256) throw new MatchingStatusUnavailableError('Invalid member id');
    let body: unknown;
    try {
      body = await this.api.getInternalMatchingStatus({ targetUserId: userId });
    } catch (error: unknown) {
      const status = httpStatusOf(error);
      throw new MatchingStatusUnavailableError(status !== undefined
        ? `Matching status returned ${status}`
        : `Matching status request failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new MatchingStatusUnavailableError('Invalid matching status body');
    }
    const record = body as Record<string, unknown>;
    if (record.userId !== userId
      || typeof record.status !== 'string'
      || !MODES.has(record.status as MatchingMode)
      || !Number.isSafeInteger(record.generation)) {
      throw new MatchingStatusUnavailableError('Invalid matching status body');
    }
    return { status: record.status as MatchingMode, generation: record.generation as number };
  }
}
