import type { RequestSigner } from './oneHookDataClient';

/**
 * Reads a member's matching mode from State before Mr OneHook uses matching data for them (chat-only
 * profiles, design §8.6).
 *
 * `GET {ONEHOOK_DATA_API_URL}/state/internal/users/{userId}/matching` is IAM-only, on the same State API
 * as the AI-context route, so it is SigV4-signed with this service's federated role
 * (OneHook-MrOneHook-<stage>-Role). State answers `{userId, status: OFF | ON | ERASING, generation}`; an
 * unknown member reads as OFF.
 *
 * Fails closed: any signing, network, HTTP or shape problem throws {@link MatchingStatusUnavailableError},
 * so a caller can never mistake "could not ask" for ON.
 */

export type MatchingMode = 'OFF' | 'ON' | 'ERASING';

export interface MatchingStatus {
  status: MatchingMode;
  generation: number;
}

export interface MatchingStatusReader {
  get(userId: string): Promise<MatchingStatus>;
}

export class MatchingStatusUnavailableError extends Error {}

const MODES = new Set<MatchingMode>(['OFF', 'ON', 'ERASING']);

export class MatchingStatusClient implements MatchingStatusReader {
  constructor(
    private readonly baseUrl: string,
    private readonly signer: RequestSigner,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(userId: string): Promise<MatchingStatus> {
    if (!userId || userId.length > 256) throw new MatchingStatusUnavailableError('Invalid member id');
    const url = new URL(`${this.baseUrl}/state/internal/users/${encodeURIComponent(userId)}/matching`);
    let response: Response;
    try {
      const headers = await this.signer.sign({ method: 'GET', url, headers: { accept: 'application/json' } });
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      throw new MatchingStatusUnavailableError(
        `Matching status request failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    if (response.status !== 200) {
      throw new MatchingStatusUnavailableError(`Matching status returned ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => undefined);
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
