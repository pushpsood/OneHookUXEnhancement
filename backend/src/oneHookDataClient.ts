import type { AiVisibleMatchContext, AiVisibleProfile } from './contextTypes';

interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string } | null>;
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
  constructor(
    private readonly baseUrl: string,
    private readonly scope: string,
    private readonly credential: TokenCredentialLike,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAiVisibleMatch(userId: string, matchId: string): Promise<AiVisibleMatchContext> {
    const token = await this.credential.getToken(this.scope);
    if (!token) throw new MatchContextUnavailableError('Service token unavailable');

    const response = await this.fetchImpl(
      `${this.baseUrl}/api/ai-context/matches/${encodeURIComponent(matchId)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token.token}`,
          'x-onehook-user-id': userId,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );

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
