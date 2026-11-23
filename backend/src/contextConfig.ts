import type { SubscriptionTier } from 'onehook-api-client';
import { parseSubscriptionTier } from 'onehook-api-client/membership';
import type { MrOneHookPlan, ProBillingPeriod } from './generated/mrOneHookModels';

export interface ContextualFeatureConfig {
  enabled: boolean;
  ready: boolean;
  missing: string[];
  authIssuer: string;
  authAudience: string;
  authJwksUri: string;
  authAlgorithms: string[];
  corsAllowedOrigins: string[];
  /** Azure Table Storage table holding the Free plan's daily message counters. */
  chatQuotaTableName: string;
  oneHookDataApiUrl: string;
  /**
   * Matching service execute-api invoke URL incl. stage (e.g. https://abc.execute-api.ap-south-1.amazonaws.com/gamma).
   * Must be the execute-api host, not the CloudFront ingress: SigV4 signs the Host header. Empty = suggestions off.
   */
  oneHookMatchingApiUrl: string;
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
  /** The token claim carrying the membership tier (`custom:subscriptionTier`, or `cognito:groups`). */
  sessionTierClaim: string;
  /** Saved-session limits per Mr OneHook plan. A plan without a policy cannot save sessions. */
  sessionPlanPolicies: Partial<Record<MrOneHookPlan, ChatSessionPlanPolicy>>;
  sessionMaxRetentionDays: number;
  /** `ONEHOOK_STAGE` (gamma, prod, ...). The fake payment provider is refused in prod. */
  stage: string;
  pro: ProConfig;
  attachments: AttachmentConfig;
}

export interface ChatSessionPlanPolicy {
  maxSessions: number;
  maxMessages: number;
  retentionDays: number;
}

export type ProPaymentProviderName = 'fake' | 'none';

export interface ProConfig {
  /** `MR_ONEHOOK_PRO_ENABLED`: the Pro purchase routes. Plans (Free, Pro by membership) apply regardless. */
  enabled: boolean;
  /** True when the Pro routes can run (enabled, member routes ready, table configured). */
  ready: boolean;
  missing: string[];
  /** Azure Table holding Pro subscriptions, ledger, notices and attachment usage. */
  tableName: string;
  /** Membership tiers that include Pro (verified from the token; no subscription needed, none sold). */
  includedTiers: SubscriptionTier[];
  /** Price per billing period, in the currency's minor unit (paise). */
  prices: Record<ProBillingPeriod, number>;
  currency: string;
  paymentProvider: ProPaymentProviderName;
  /** How often the renewal job looks for due subscriptions. */
  renewalIntervalMs: number;
  /** `MR_ONEHOOK_ENTITLEMENT_QUEUE_URL`: SQS queue with the membership's Pro handover events. */
  entitlementQueueUrl: string;
}

export interface AttachmentConfig {
  /** `CHAT_ATTACHMENTS_ENABLED`. */
  enabled: boolean;
  /** Enabled, member routes and session storage ready, and the Pro table (usage ledger) configured. */
  ready: boolean;
  missing: string[];
  maxBytes: number;
  maxPerMessage: number;
  /** Monthly file-processing allowance in paise, by why the member is on Pro. */
  monthlyBudgetMinor: { subscription: number; membership: number };
  /** At most `burstFiles` uploads per `burstWindowMs`. */
  burstFiles: number;
  burstWindowMs: number;
  /** Cost rates in paise, used to meter the allowance. */
  rates: AttachmentCostRates;
  /** Image description deployment (defaults to the chat deployment). */
  visionDeployment: string;
  /** Speech-to-text deployment; empty = audio and video are not accepted. */
  transcriptionDeployment: string;
  /** Endpoint of the transcription deployment (defaults to AZURE_OPENAI_ENDPOINT). */
  transcriptionEndpoint: string;
  /** Azure AI Document Intelligence endpoint; empty = PDF and Office files are not accepted. */
  documentIntelligenceEndpoint: string;
  /** Pages read from one document. */
  maxDocumentPages: number;
  /** Longest audio or video accepted, in seconds. */
  maxMediaSeconds: number;
  /** Optional ffmpeg binary for video keyframes; without it a video is read from its sound only. */
  ffmpegPath: string;
}

export interface AttachmentCostRates {
  /** Per million input tokens of the vision model. */
  inputTokensPerMillion: number;
  /** Per million output tokens of the vision model. */
  outputTokensPerMillion: number;
  /** Per minute of transcribed audio. */
  transcriptionPerMinute: number;
  /** Per document page read. */
  documentPage: number;
}

/** The plans (generated `MrOneHookPlan`) as policy keys; `CHAT_SESSION_PLAN_POLICIES` uses lower case. */
const PLAN_KEYS: Readonly<Record<string, MrOneHookPlan>> = { free: 'FREE', pro: 'PRO' };

/**
 * Canonical tier for policy lookup.
 *
 * Membership tiers are owned by the OneHook backend Smithy model (`club.onehook.common#SubscriptionTier`)
 * and consumed ONLY from `onehook-api-client` — never re-declared here. The SDK parser accepts a tier
 * (Must / Super / Infinity, any case) and returns its wire value; anything else is `undefined`.
 */
export function normalizeTier(raw: unknown): SubscriptionTier | undefined {
  return parseSubscriptionTier(raw);
}

function parsePlanPolicies(
  raw: string | undefined,
  maxRetentionDays: number,
): Partial<Record<MrOneHookPlan, ChatSessionPlanPolicy>> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const policies: Partial<Record<MrOneHookPlan, ChatSessionPlanPolicy>> = {};
    for (const [rawPlan, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A key that is not a plan is ignored, so a stale tier key can never silently gate anything.
      const plan = PLAN_KEYS[rawPlan.trim().toLowerCase()];
      if (!plan
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
      policies[plan] = { maxSessions, maxMessages, retentionDays };
    }
    return policies;
  } catch {
    return {};
  }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** A positive safe integer from `value`, else the fallback. */
function positiveInteger(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max ? value as number : fallback;
}

/** A non-negative finite number from `value`, else the fallback. */
function rate(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Attachments are limited to 5 MiB each (the product promise; not configurable). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 3;

/** Default Pro prices (paise): Rs 799 per month, Rs 5,999 per year. */
export const DEFAULT_PRO_PRICES: Readonly<Record<ProBillingPeriod, number>> = { MONTHLY: 79_900, YEARLY: 599_900 };

/**
 * Default cost rates (paise), from list prices converted at about Rs 84 per USD: vision input $2.50 and
 * output $10 per million tokens, transcription $0.006 per minute, document reading $1.50 per 1000 pages.
 */
export const DEFAULT_ATTACHMENT_RATES: Readonly<AttachmentCostRates> = {
  inputTokensPerMillion: 21_000,
  outputTokensPerMillion: 84_000,
  transcriptionPerMinute: 50,
  documentPage: 12.6,
};

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
  // The OneHook AWS routes (AI context, suggestions) are AWS_IAM only, so calls are always SigV4-signed.
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
    oneHookMatchingApiUrl: env.ONEHOOK_MATCHING_API_URL?.trim().replace(/\/$/, '') ?? '',
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
    ['ONEHOOK_DATA_API_AWS_REGION', values.oneHookDataApiAwsRegion],
  ];
  const missing = required.filter(([, value]) => value.length === 0).map(([name]) => name);

  const sessionStorageEnabled = readBoolean(env.CHAT_SESSION_STORAGE_ENABLED, false);
  // The Cognito token claim carrying the subscription tier. Defaults to the ACTUAL custom attribute
  // the backend/Identity writes (`custom:subscriptionTier`). Can be overridden to `cognito:groups`.
  const sessionTierClaim = env.AUTH_TIER_CLAIM?.trim() ?? 'custom:subscriptionTier';
  const sessionMaxRetentionDays = readInteger(env.CHAT_SESSION_MAX_RETENTION_DAYS, 90, 1, 365);
  const sessionPlanPolicies = parsePlanPolicies(env.CHAT_SESSION_PLAN_POLICIES, sessionMaxRetentionDays);
  if (env.CHAT_SESSION_TIER_POLICIES?.trim()) {
    console.warn('[WARN] CHAT_SESSION_TIER_POLICIES is ignored: saved sessions are limited per plan (CHAT_SESSION_PLAN_POLICIES)');
  }
  const sessionMissing: string[] = [];
  if (sessionStorageEnabled) {
    if (!sessionTierClaim) sessionMissing.push('AUTH_TIER_CLAIM');
    if (Object.keys(sessionPlanPolicies).length === 0) sessionMissing.push('CHAT_SESSION_PLAN_POLICIES');
  }
  const contextualReady = enabled && missing.length === 0;
  const sessionStorageReady = contextualReady && sessionStorageEnabled && sessionMissing.length === 0;
  const stage = env.ONEHOOK_STAGE?.trim().toLowerCase() ?? '';

  // ── Mr OneHook Pro ──
  const proEnabled = readBoolean(env.MR_ONEHOOK_PRO_ENABLED, false);
  const proTableName = env.AZURE_PRO_TABLE?.trim() ?? '';
  const includedTiers = (env.MR_ONEHOOK_PRO_INCLUDED_TIERS ?? '')
    .split(',')
    .map((value) => normalizeTier(value))
    .filter((tier): tier is SubscriptionTier => tier !== undefined);
  const rawPrices = parseJsonObject(env.MR_ONEHOOK_PRO_PRICES) ?? {};
  const prices: Record<ProBillingPeriod, number> = {
    MONTHLY: positiveInteger(rawPrices.monthly, DEFAULT_PRO_PRICES.MONTHLY, 10_000_000),
    YEARLY: positiveInteger(rawPrices.yearly, DEFAULT_PRO_PRICES.YEARLY, 100_000_000),
  };
  const requestedProvider = env.MR_ONEHOOK_PRO_PAYMENT_PROVIDER?.trim().toLowerCase() ?? '';
  const proMissing: string[] = [];
  let paymentProvider: ProPaymentProviderName = 'none';
  if (requestedProvider === 'fake') {
    // The fake provider charges nobody; it must never take real purchases.
    if (stage === 'prod' || stage === '') proMissing.push('MR_ONEHOOK_PRO_PAYMENT_PROVIDER=fake is refused unless ONEHOOK_STAGE is a non-prod stage');
    else paymentProvider = 'fake';
  } else if (requestedProvider && requestedProvider !== 'none') {
    proMissing.push(`MR_ONEHOOK_PRO_PAYMENT_PROVIDER '${requestedProvider.slice(0, 32)}' is not supported`);
  }
  if (proEnabled) {
    if (!proTableName) proMissing.push('AZURE_PRO_TABLE');
    if (!contextualReady) proMissing.push('member routes not ready');
  }
  const pro: ProConfig = {
    enabled: proEnabled,
    ready: proEnabled && contextualReady && proTableName.length > 0,
    missing: proMissing,
    tableName: proTableName,
    includedTiers,
    prices,
    currency: 'INR',
    paymentProvider,
    renewalIntervalMs: readInteger(env.MR_ONEHOOK_PRO_RENEWAL_INTERVAL_MS, 300_000, 10_000, 3_600_000),
    entitlementQueueUrl: env.MR_ONEHOOK_ENTITLEMENT_QUEUE_URL?.trim() ?? '',
  };

  // ── Attachments ──
  const attachmentsEnabled = readBoolean(env.CHAT_ATTACHMENTS_ENABLED, false);
  const rawBudget = parseJsonObject(env.ATTACHMENT_MONTHLY_BUDGET_MINOR) ?? {};
  const rawRates = parseJsonObject(env.ATTACHMENT_COST_RATES) ?? {};
  const attachmentMissing: string[] = [];
  if (attachmentsEnabled) {
    if (!sessionStorageReady) attachmentMissing.push('chat session storage not ready');
    if (!proTableName) attachmentMissing.push('AZURE_PRO_TABLE');
  }
  const attachments: AttachmentConfig = {
    enabled: attachmentsEnabled,
    ready: attachmentsEnabled && attachmentMissing.length === 0,
    missing: attachmentMissing,
    maxBytes: MAX_ATTACHMENT_BYTES,
    maxPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
    monthlyBudgetMinor: {
      subscription: positiveInteger(rawBudget.subscription, 40_000),
      membership: positiveInteger(rawBudget.membership, 40_000),
    },
    burstFiles: readInteger(env.ATTACHMENT_BURST_FILES, 10, 1, 100),
    burstWindowMs: readInteger(env.ATTACHMENT_BURST_WINDOW_MS, 600_000, 60_000, 86_400_000),
    rates: {
      inputTokensPerMillion: rate(rawRates.inputTokensPerMillion, DEFAULT_ATTACHMENT_RATES.inputTokensPerMillion),
      outputTokensPerMillion: rate(rawRates.outputTokensPerMillion, DEFAULT_ATTACHMENT_RATES.outputTokensPerMillion),
      transcriptionPerMinute: rate(rawRates.transcriptionPerMinute, DEFAULT_ATTACHMENT_RATES.transcriptionPerMinute),
      documentPage: rate(rawRates.documentPage, DEFAULT_ATTACHMENT_RATES.documentPage),
    },
    visionDeployment: env.AZURE_OPENAI_VISION_DEPLOYMENT?.trim() || env.AZURE_OPENAI_DEPLOYMENT?.trim() || 'gpt-4o',
    transcriptionDeployment: env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT?.trim() ?? '',
    transcriptionEndpoint: env.AZURE_OPENAI_TRANSCRIPTION_ENDPOINT?.trim() || env.AZURE_OPENAI_ENDPOINT?.trim() || '',
    documentIntelligenceEndpoint: env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.trim().replace(/\/$/, '') ?? '',
    maxDocumentPages: readInteger(env.ATTACHMENT_MAX_DOCUMENT_PAGES, 50, 1, 500),
    maxMediaSeconds: readInteger(env.ATTACHMENT_MAX_MEDIA_SECONDS, 1_800, 30, 7_200),
    ffmpegPath: env.FFMPEG_PATH?.trim() ?? '',
  };

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
    chatQuotaTableName: env.AZURE_CHAT_QUOTA_TABLE?.trim() ?? '',
    maxInputCharacters: readInteger(env.CONTEXT_MAX_INPUT_CHARACTERS, 4000, 100, 16000),
    maxEphemeralMessages: readInteger(env.EPHEMERAL_CONTEXT_MAX_MESSAGES, 30, 1, 100),
    maxEphemeralCharacters: readInteger(env.EPHEMERAL_CONTEXT_MAX_CHARACTERS, 12000, 500, 50000),
    contextRequestMaxMessages: readInteger(env.CONTEXT_REQUEST_MAX_MESSAGES, 8, 1, 20),
    dataApiTimeoutMs: readInteger(env.ONEHOOK_DATA_API_TIMEOUT_MS, 3000, 250, 30000),
    sessionStorageEnabled,
    sessionStorageReady,
    sessionMissing,
    sessionTierClaim,
    sessionPlanPolicies,
    sessionMaxRetentionDays,
    stage,
    pro,
    attachments,
  };
}
