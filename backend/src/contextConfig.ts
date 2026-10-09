export interface ContextualFeatureConfig {
  enabled: boolean;
  ready: boolean;
  missing: string[];
  authIssuer: string;
  authAudience: string;
  authJwksUri: string;
  authAlgorithms: string[];
  corsAllowedOrigins: string[];
  userChatPermission: string;
  oneHookDataApiUrl: string;
  oneHookDataApiScope: string;
  storageAccountName: string;
  sessionContainerName: string;
  maxInputCharacters: number;
  maxEphemeralMessages: number;
  maxEphemeralCharacters: number;
  contextRequestMaxMessages: number;
  dataApiTimeoutMs: number;
  sessionStorageEnabled: boolean;
  sessionStorageReady: boolean;
  sessionMissing: string[];
  sessionTierClaim: string;
  sessionTierPolicies: Record<string, ChatSessionTierPolicy>;
  sessionMaxRetentionDays: number;
}

export interface ChatSessionTierPolicy {
  maxSessions: number;
  maxMessages: number;
  retentionDays: number;
}

function parseTierPolicies(raw: string | undefined, maxRetentionDays: number): Record<string, ChatSessionTierPolicy> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const policies: Record<string, ChatSessionTierPolicy> = {};
    for (const [rawTier, value] of Object.entries(parsed as Record<string, unknown>)) {
      const tier = rawTier.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tier)
        || typeof value !== 'object'
        || value === null
        || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      if (candidate.enabled !== true
        || !Number.isSafeInteger(candidate.maxSessions)
        || !Number.isSafeInteger(candidate.maxMessages)
        || !Number.isSafeInteger(candidate.retentionDays)) continue;
      const maxSessions = candidate.maxSessions as number;
      const maxMessages = candidate.maxMessages as number;
      const retentionDays = candidate.retentionDays as number;
      if (maxSessions < 1 || maxSessions > 100
        || maxMessages < 2 || maxMessages > 200
        || retentionDays < 1 || retentionDays > maxRetentionDays) continue;
      policies[tier] = { maxSessions, maxMessages, retentionDays };
    }
    return policies;
  } catch {
    return {};
  }
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function readInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function loadContextualFeatureConfig(env: NodeJS.ProcessEnv = process.env): ContextualFeatureConfig {
  const enabled = readBoolean(env.CONTEXTUAL_AI_ENABLED, false);
  const values = {
    authIssuer: env.AUTH_ISSUER?.trim() ?? '',
    authAudience: env.AUTH_AUDIENCE?.trim() ?? '',
    authJwksUri: env.AUTH_JWKS_URI?.trim() ?? '',
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    oneHookDataApiUrl: env.ONEHOOK_DATA_API_URL?.trim().replace(/\/$/, '') ?? '',
    oneHookDataApiScope: env.ONEHOOK_DATA_API_SCOPE?.trim() ?? '',
    storageAccountName: env.AZURE_STORAGE_ACCOUNT?.trim() ?? '',
    sessionContainerName: env.AZURE_SESSION_CONTAINER?.trim() ?? '',
  };

  const required: Array<[string, string]> = [
    ['AUTH_ISSUER', values.authIssuer],
    ['AUTH_AUDIENCE', values.authAudience],
    ['AUTH_JWKS_URI', values.authJwksUri],
    ['CORS_ALLOWED_ORIGINS', values.corsAllowedOrigins.join(',')],
    ['ONEHOOK_DATA_API_URL', values.oneHookDataApiUrl],
    ['ONEHOOK_DATA_API_SCOPE', values.oneHookDataApiScope],
    ['AZURE_STORAGE_ACCOUNT', values.storageAccountName],
    ['AZURE_SESSION_CONTAINER', values.sessionContainerName],
  ];
  const missing = required.filter(([, value]) => value.length === 0).map(([name]) => name);

  const sessionStorageEnabled = readBoolean(env.CHAT_SESSION_STORAGE_ENABLED, false);
  const sessionTierClaim = env.AUTH_TIER_CLAIM?.trim() ?? 'custom:tier';
  const sessionMaxRetentionDays = readInteger(env.CHAT_SESSION_MAX_RETENTION_DAYS, 90, 1, 365);
  const sessionTierPolicies = parseTierPolicies(env.CHAT_SESSION_TIER_POLICIES, sessionMaxRetentionDays);
  const sessionMissing: string[] = [];
  if (sessionStorageEnabled) {
    if (!sessionTierClaim) sessionMissing.push('AUTH_TIER_CLAIM');
    if (Object.keys(sessionTierPolicies).length === 0) sessionMissing.push('CHAT_SESSION_TIER_POLICIES');
  }
  const contextualReady = enabled && missing.length === 0;

  return {
    enabled,
    ready: contextualReady,
    missing,
    ...values,
    authAlgorithms: (() => {
      const asymmetricAlgorithms = new Set([
        'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512',
      ]);
      const configured = (env.AUTH_ALLOWED_ALGORITHMS ?? 'RS256')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => asymmetricAlgorithms.has(value));
      return configured.length > 0 ? configured : ['RS256'];
    })(),
    userChatPermission: env.AUTH_CHAT_PERMISSION?.trim() ?? 'context.chat',
    maxInputCharacters: readInteger(env.CONTEXT_MAX_INPUT_CHARACTERS, 4000, 100, 16000),
    maxEphemeralMessages: readInteger(env.EPHEMERAL_CONTEXT_MAX_MESSAGES, 30, 1, 100),
    maxEphemeralCharacters: readInteger(env.EPHEMERAL_CONTEXT_MAX_CHARACTERS, 12000, 500, 50000),
    contextRequestMaxMessages: readInteger(env.CONTEXT_REQUEST_MAX_MESSAGES, 8, 1, 20),
    dataApiTimeoutMs: readInteger(env.ONEHOOK_DATA_API_TIMEOUT_MS, 3000, 250, 30000),
    sessionStorageEnabled,
    sessionStorageReady: contextualReady && sessionStorageEnabled && sessionMissing.length === 0,
    sessionMissing,
    sessionTierClaim,
    sessionTierPolicies,
    sessionMaxRetentionDays,
  };
}
