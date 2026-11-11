import { MATCHING_PROFILE_FIELDS, type AiVisibleMatchContext, type AiVisibleProfile } from './contextTypes';

/**
 * Produces the authorization headers for a single outbound request to the authoritative OneHook
 * data API.
 *
 * <p>The data API is the trusted, cross-cloud projection endpoint in the OneHook AWS backend. Its route
 * is authorized with {@code AWS_IAM}, so {@link SigV4RequestSigner} attaches SigV4 headers (credentials
 * from the Azure managed identity exchanged for the federated AWS role).</p>
 *
 * <p>The method/url/headers passed in already include {@code X-OneHook-User-Id} and {@code accept};
 * the signer returns the complete header set to send (including any it adds, e.g. Authorization,
 * X-Amz-Date, X-Amz-Security-Token). It must never throw for a missing credential by returning a
 * header set that would silently succeed — a signer that cannot authenticate returns headers that
 * fail closed at the server (401/403), which the caller maps to an unavailable match.</p>
 */
export interface RequestSigner {
  sign(request: {
    method: string;
    url: URL;
    headers: Record<string, string>;
    /** Exact request body; SigV4 signs its hash, so it must be the bytes that are sent. */
    body?: string;
  }): Promise<Record<string, string>>;
}

export class MatchContextUnavailableError extends Error {}
export class MatchContextAccessError extends Error {}

const ALLOWED_PROFILE_FIELDS = new Set<string>(['displayName', ...MATCHING_PROFILE_FIELDS]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 25);
  return result.length > 0 ? result : undefined;
}

export function sanitizeVisibleProfile(value: unknown): AiVisibleProfile {
  if (!isRecord(value)) return {};
  const result: AiVisibleProfile = {};
  for (const key of Object.keys(value)) {
    if (!ALLOWED_PROFILE_FIELDS.has(key)) continue;
    if (key === 'displayName' || key === 'pronouns') {
      const text = sanitizeText(value[key], 100);
      if (text) result[key] = text;
    } else if (key === 'bio') {
      const text = sanitizeText(value[key], 1000);
      if (text) result.bio = text;
    } else {
      const list = sanitizeStringList(value[key]);
      if (!list) continue;
      if (key === 'interests') result.interests = list;
      if (key === 'communicationPreferences') result.communicationPreferences = list;
      if (key === 'relationshipGoals') result.relationshipGoals = list;
    }
  }
  return result;
}

/** True when the projection carries at least one matching-profile field. */
export function hasMatchingFields(profile: AiVisibleProfile): boolean {
  return MATCHING_PROFILE_FIELDS.some((field) => profile[field] !== undefined);
}

/** The chat-profile part only: the display name, when there is one. */
export function chatOnlyProfile(profile: AiVisibleProfile): AiVisibleProfile {
  return profile.displayName !== undefined ? { displayName: profile.displayName } : {};
}

/**
 * Both participants as the AI may see them. Matching fields are kept only when BOTH projections carry
 * some; otherwise both are reduced to their display names. State already withholds matching fields
 * unless both members' matching profiles are ACTIVE (design §8.6); this is the same rule applied again
 * on receipt, so a one-sided projection can never reach the model.
 */
export function visibleProfilesForPair(
  requestingUser: AiVisibleProfile,
  matchedUser: AiVisibleProfile,
): { requestingUser: AiVisibleProfile; matchedUser: AiVisibleProfile } {
  if (hasMatchingFields(requestingUser) && hasMatchingFields(matchedUser)) {
    return { requestingUser, matchedUser };
  }
  return { requestingUser: chatOnlyProfile(requestingUser), matchedUser: chatOnlyProfile(matchedUser) };
}

export class OneHookDataClient {
  private readonly baseUrl: string;
  private readonly signer: RequestSigner;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private constructor(
    baseUrl: string,
    signer: RequestSigner,
    timeoutMs: number,
    fetchImpl: typeof fetch,
  ) {
    this.baseUrl = baseUrl;
    this.signer = signer;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Constructs a client with an explicit request signer. This is the entry point used in production
   * when the data API is the AWS AI-context route (AuthorizationType AWS_IAM), where
   * {@link SigV4RequestSigner} attaches SigV4 headers rather than a bearer token.
   */
  static withSigner(
    baseUrl: string,
    signer: RequestSigner,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
  ): OneHookDataClient {
    return new OneHookDataClient(baseUrl, signer, timeoutMs, fetchImpl);
  }

  async getAiVisibleMatch(userId: string, matchId: string): Promise<AiVisibleMatchContext> {
    const url = new URL(`${this.baseUrl}/api/ai-context/matches/${encodeURIComponent(matchId)}`);
    const baseHeaders: Record<string, string> = {
      'x-onehook-user-id': userId,
      accept: 'application/json',
    };

    let headers: Record<string, string>;
    try {
      headers = await this.signer.sign({ method: 'GET', url, headers: baseHeaders });
    } catch (error: unknown) {
      // A signer failure (e.g. no resolvable AWS credentials) is a configuration/availability
      // problem, not a per-match authorization decision — surface it as unavailable, never as if the
      // match simply does not exist.
      throw new MatchContextUnavailableError(
        `Failed to sign data-service request: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 403 || response.status === 404) {
      throw new MatchContextAccessError('Match is not available');
    }
    if (!response.ok) throw new MatchContextUnavailableError(`Data service returned ${response.status}`);

    const body: unknown = await response.json();
    if (!isRecord(body) || body.matchId !== matchId || body.status !== 'active') {
      throw new MatchContextAccessError('Match is not active');
    }
    if (!isRecord(body.requestingUser) || body.requestingUser.id !== userId) {
      throw new MatchContextAccessError('User is not the requesting match participant');
    }
    if (!isRecord(body.matchedUser) || !isRecord(body.contextPolicy)) {
      throw new MatchContextUnavailableError('Invalid data-service projection');
    }

    return {
      matchId,
      status: 'active',
      ...visibleProfilesForPair(
        sanitizeVisibleProfile(body.requestingUser.visibleProfile),
        sanitizeVisibleProfile(body.matchedUser.visibleProfile),
      ),
      profileAllowed: body.contextPolicy.profileAllowed === true,
      messageHistoryAllowed: body.contextPolicy.messageHistoryAllowed === true,
      policyVersion: typeof body.contextPolicy.policyVersion === 'string'
        ? body.contextPolicy.policyVersion.slice(0, 100)
        : 'unknown',
    };
  }
}
