import type { AiVisibleMatchContext, AiVisibleProfile } from './contextTypes';

interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string } | null>;
}

/**
 * Produces the authorization headers for a single outbound request to the authoritative OneHook
 * data API.
 *
 * <p>The data API is the trusted, cross-cloud projection endpoint that lives in the OneHook AWS
 * backend. Two concrete signing strategies implement this seam:</p>
 * <ul>
 *   <li>{@link BearerTokenSigner} — attaches an OAuth bearer token (used when the data API is fronted
 *       by a token authorizer; also what the unit tests use).</li>
 *   <li>{@link SigV4RequestSigner} — attaches AWS SigV4 headers, required because the AWS API Gateway
 *       route for the AI-context projection is authorized with {@code AWS_IAM}. An Azure App Service
 *       managed identity cannot mint AWS SigV4 directly, so the signer resolves AWS credentials from
 *       the standard provider chain (env vars / web-identity federation configured on the host).</li>
 * </ul>
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

/** Bearer-token signer backed by an Azure/OAuth token credential. */
export class BearerTokenSigner implements RequestSigner {
  constructor(
    private readonly credential: TokenCredentialLike,
    private readonly scope: string,
  ) {}

  async sign(request: {
    method: string;
    url: URL;
    headers: Record<string, string>;
  }): Promise<Record<string, string>> {
    const token = await this.credential.getToken(this.scope);
    if (!token) {
      // Fail closed: send no Authorization header, so the server rejects with 401 and the caller
      // surfaces an unavailable match rather than silently proceeding unauthenticated.
      return request.headers;
    }
    return { ...request.headers, authorization: `Bearer ${token.token}` };
  }
}

export class MatchContextUnavailableError extends Error {}
export class MatchContextAccessError extends Error {}

const ALLOWED_PROFILE_FIELDS = new Set([
  'displayName',
  'pronouns',
  'bio',
  'interests',
  'communicationPreferences',
  'relationshipGoals',
]);

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
   * Backward-compatible factory. Historically the client was given an Azure/OAuth token credential +
   * scope and attached a bearer token; that behaviour is preserved via {@link BearerTokenSigner} so
   * existing wiring and tests are unchanged. The {@code new OneHookDataClient(url, scope, cred, ...)}
   * call shape is kept by routing through this factory from a thin static wrapper below.
   */
  static withBearer(
    baseUrl: string,
    scope: string,
    credential: TokenCredentialLike,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
  ): OneHookDataClient {
    return new OneHookDataClient(baseUrl, new BearerTokenSigner(credential, scope), timeoutMs, fetchImpl);
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
      requestingUser: sanitizeVisibleProfile(body.requestingUser.visibleProfile),
      matchedUser: sanitizeVisibleProfile(body.matchedUser.visibleProfile),
      profileAllowed: body.contextPolicy.profileAllowed === true,
      messageHistoryAllowed: body.contextPolicy.messageHistoryAllowed === true,
      policyVersion: typeof body.contextPolicy.policyVersion === 'string'
        ? body.contextPolicy.policyVersion.slice(0, 100)
        : 'unknown',
    };
  }
}
