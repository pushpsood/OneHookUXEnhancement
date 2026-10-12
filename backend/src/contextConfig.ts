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
  oneHookDataApiAuthMode: 'sigv4' | 'bearer';
  oneHookDataApiAwsRegion: string;
  oneHookDataApiAwsService: string;
  oneHookDataApiAwsRoleArn: string;
  oneHookDataApiAwsWebIdentityAudience: string;
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

/**
 * Canonical tier key used for session-policy lookup.
 *
 * The backend's subscription-tier WIRE values are frozen as `FREE`/`GOLD`/`PLATINUM` (see
 * `SubscriptionTier.java`), while the product/marketing DISPLAY names are `Must`/`Super`/`Infinity`
 * (the iOS membership page is the source of truth). A member's token may carry either form depending
 * on which attribute/claim populated it, so both the policy keys and the token claim are normalised
 * through this one function to a canonical lowercase wire value. That means a policy keyed `gold`,
 * `GOLD`, or `super` all resolve the same, and a claim of `GOLD`/`Super`/`super` all match it.
 */
export function normalizeTier(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toUpperCase();
  switch (normalized) {
    case 'FREE':
    case 'MUST':
      return 'free';
    case 'GOLD':
    case 'SUPER':
      return 'gold';
    case 'PLATINUM':
    case 'INFINITY':
      return 'platinum';
    default:
      return undefined;
  }
}

function parseTierPolicies(raw: string | undefined, maxRetentionDays: number): Record<string, ChatSessionTierPolicy> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const policies: Record<string, ChatSessionTierPolicy> = {};
    for (const [rawTier, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Normalise the policy KEY to a canonical wire tier (free/gold/platinum). A key that is not a
      // recognised tier (wire or Must/Super/Infinity alias) is ignored, so a stale `premium` key can
      // never silently gate anything.
      const tier = normalizeTier(rawTier);
      if (!tier
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
  // How the backend authenticates to the authoritative data API. 'sigv4' (default) targets the AWS
  // API Gateway AI-context route (AuthorizationType AWS_IAM); 'bearer' targets a token-authorized
  // endpoint and uses ONEHOOK_DATA_API_SCOPE. The mode decides which settings are required.
  const authMode: 'sigv4' | 'bearer' =
    (env.ONEHOOK_DATA_API_AUTH_MODE?.trim().toLowerCase() === 'bearer') ? 'bearer' : 'sigv4';
  const awsRegion = env.ONEHOOK_DATA_API_AWS_REGION?.trim()
    ?? env.AWS_REGION?.trim()
    ?? '';
  const awsService = env.ONEHOOK_DATA_API_AWS_SERVICE?.trim() || 'execute-api';
  // Optional cross-cloud web-identity: when both are set, the backend exchanges an Azure
  // managed-identity token for AWS credentials via STS AssumeRoleWithWebIdentity instead of relying
  // on the ambient AWS provider chain. Absence falls back to fromNodeProviderChain.
  const awsRoleArn = env.ONEHOOK_DATA_API_AWS_ROLE_ARN?.trim() ?? '';
  const awsWebIdentityAudience = env.ONEHOOK_DATA_API_AWS_WEB_IDENTITY_AUDIENCE?.trim() ?? '';
  const values = {
    authIssuer: env.AUTH_ISSUER?.trim() ?? '',
    authAudience: env.AUTH_AUDIENCE?.trim() ?? '',
    authJwksUri: env.AUTH_JWKS_URI?.trim() ?? '',
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    oneHookDataApiUrl: env.ONEHOOK_DATA_API_URL?.trim().replace(/\/$/, '') ?? '',
    oneHookDataApiScope: env.ONEHOOK_DATA_API_SCOPE?.trim() ?? '',
    oneHookDataApiAuthMode: authMode,
    oneHookDataApiAwsRegion: awsRegion,
    oneHookDataApiAwsService: awsService,
    oneHookDataApiAwsRoleArn: awsRoleArn,
    oneHookDataApiAwsWebIdentityAudience: awsWebIdentityAudience,
    storageAccountName: env.AZURE_STORAGE_ACCOUNT?.trim() ?? '',
    sessionContainerName: env.AZURE_SESSION_CONTAINER?.trim() ?? '',
  };

  const required: Array<[string, string]> = [
    ['AUTH_ISSUER', values.authIssuer],
    ['AUTH_AUDIENCE', values.authAudience],
    ['AUTH_JWKS_URI', values.authJwksUri],
    ['CORS_ALLOWED_ORIGINS', values.corsAllowedOrigins.join(',')],
    ['ONEHOOK_DATA_API_URL', values.oneHookDataApiUrl],
    ['AZURE_STORAGE_ACCOUNT', values.storageAccountName],
    ['AZURE_SESSION_CONTAINER', values.sessionContainerName],
    // Mode-specific: SigV4 needs a region; bearer needs a scope. Enforcing per-mode keeps the
    // readiness check honest — a SigV4 deployment is not blocked by a missing OAuth scope, and a
    // bearer deployment is not silently unauthenticated for lack of a region.
    ...(authMode === 'sigv4'
      ? ([['ONEHOOK_DATA_API_AWS_REGION', values.oneHookDataApiAwsRegion]] as Array<[string, string]>)
      : ([['ONEHOOK_DATA_API_SCOPE', values.oneHookDataApiScope]] as Array<[string, string]>)),
  ];
  const missing = required.filter(([, value]) => value.length === 0).map(([name]) => name);

  const sessionStorageEnabled = readBoolean(env.CHAT_SESSION_STORAGE_ENABLED, false);
  // The Cognito token claim carrying the subscription tier. Defaults to the ACTUAL custom attribute
  // the backend/Identity writes (`custom:subscriptionTier`); the old `custom:tier` default never
  // existed on the pool, so tier resolution always failed. Can be overridden to `cognito:groups`.
  const sessionTierClaim = env.AUTH_TIER_CLAIM?.trim() ?? 'custom:subscriptionTier';
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
