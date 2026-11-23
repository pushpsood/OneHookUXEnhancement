import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPermissions, resolveMembershipTier } from '../auth';
import { SubscriptionTier } from 'onehook-api-client';
import { SUBSCRIPTION_TIERS, parseSubscriptionTier } from 'onehook-api-client/membership';
import { loadContextualFeatureConfig, normalizeTier } from '../contextConfig';
import { parseContextualChatInput } from '../contextTypes';

test('contextual feature is disabled and not ready by default', () => {
  const config = loadContextualFeatureConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.ready, false);
  assert.ok(config.missing.includes('AUTH_ISSUER'));
});

test('contextual feature becomes ready only with every integration setting', () => {
  const config = loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true',
    AUTH_ISSUER: 'https://issuer.example',
    AUTH_AUDIENCE: 'onehook-context',
    AUTH_JWKS_URI: 'https://issuer.example/jwks',
    CORS_ALLOWED_ORIGINS: 'https://app.onehook.example',
    ONEHOOK_DATA_API_URL: 'https://data.example/',
    ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1',
    AZURE_STORAGE_ACCOUNT: 'storage',
    AZURE_SESSION_CONTAINER: 'aisessions',
    EPHEMERAL_CONTEXT_MAX_MESSAGES: '500',
  });
  assert.equal(config.ready, true);
  assert.equal(config.oneHookDataApiUrl, 'https://data.example');
  assert.equal(config.maxEphemeralMessages, 30, 'out-of-range limits use the safe default');
});

test('data API auth mode decides which integration setting is required', () => {
  const base = {
    CONTEXTUAL_AI_ENABLED: 'true',
    AUTH_ISSUER: 'https://issuer.example',
    AUTH_AUDIENCE: 'user-api',
    AUTH_JWKS_URI: 'https://issuer.example/jwks',
    CORS_ALLOWED_ORIGINS: 'https://app.example',
    ONEHOOK_DATA_API_URL: 'https://api.gamma.onehook.club',
    AZURE_STORAGE_ACCOUNT: 'storage',
    AZURE_SESSION_CONTAINER: 'aisessions',
  };

  // A region is required (calls are always SigV4-signed).
  const sigv4Missing = loadContextualFeatureConfig(base);
  assert.equal(sigv4Missing.ready, false);
  assert.ok(sigv4Missing.missing.includes('ONEHOOK_DATA_API_AWS_REGION'));

  const sigv4Ready = loadContextualFeatureConfig({ ...base, ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1' });
  assert.equal(sigv4Ready.ready, true);
  assert.equal(sigv4Ready.oneHookDataApiAwsService, 'execute-api');

});

test('permissions combine OAuth scopes and roles', () => {
  const permissions = extractPermissions({
    scope: 'context.chat profile.read',
    roles: ['member.support'],
  });
  assert.deepEqual([...permissions].sort(), ['context.chat', 'member.support', 'profile.read']);
});

test('contextual request accepts only bounded server-resolved identifiers and current text', () => {
  const input = parseContextualChatInput({
    matchId: 'match-1',
    message: '  hello  ',
    userId: 'ignored-but-never-used',
    contextOptions: { includeProfile: false, includeMessageHistory: true },
  }, 100);
  assert.deepEqual(input, {
    matchId: 'match-1',
    message: 'hello',
    includeProfile: false,
    includeMessageHistory: true,
    persistSession: false,
    attachmentIds: [],
  });
  assert.throws(() => parseContextualChatInput({ matchId: 'match-1', message: 'x'.repeat(101) }, 100));
});

test('symmetric JWT algorithms are rejected', () => {
  const config = loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true',
    AUTH_ISSUER: 'https://issuer.example',
    AUTH_AUDIENCE: 'user-api',
    AUTH_JWKS_URI: 'https://issuer.example/jwks',
    CORS_ALLOWED_ORIGINS: 'https://app.onehook.example',
    ONEHOOK_DATA_API_URL: 'https://data.example',
    ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1',
    AZURE_STORAGE_ACCOUNT: 'storage',
    AZURE_SESSION_CONTAINER: 'aisessions',
    AUTH_ALLOWED_ALGORITHMS: 'HS256',
  });
  assert.equal(config.ready, true);
  assert.deepEqual(config.authAlgorithms, ['RS256']);
});

test('session storage becomes ready only with a valid bounded plan policy', () => {
  const base = {
    CONTEXTUAL_AI_ENABLED: 'true',
    AUTH_ISSUER: 'https://issuer.example',
    AUTH_AUDIENCE: 'user-api',
    AUTH_JWKS_URI: 'https://issuer.example/jwks',
    CORS_ALLOWED_ORIGINS: 'https://app.example',
    ONEHOOK_DATA_API_URL: 'https://data.example',
    ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1',
    AZURE_STORAGE_ACCOUNT: 'storage',
    AZURE_SESSION_CONTAINER: 'aisessions',
    CHAT_SESSION_STORAGE_ENABLED: 'true',
  };
  // Keys are plans (any case); disabled or out-of-bounds policies are dropped.
  const valid = loadContextualFeatureConfig({
    ...base,
    CHAT_SESSION_PLAN_POLICIES: JSON.stringify({
      Free: { enabled: true, maxSessions: 1, maxMessages: 50, retentionDays: 30 },
      PRO: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 },
      super: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 },
    }),
  });
  assert.equal(valid.sessionStorageReady, true);
  assert.deepEqual(valid.sessionPlanPolicies, {
    FREE: { maxSessions: 1, maxMessages: 50, retentionDays: 30 },
    PRO: { maxSessions: 3, maxMessages: 50, retentionDays: 30 },
  });

  const invalid = loadContextualFeatureConfig({ ...base, CHAT_SESSION_PLAN_POLICIES: '{bad-json' });
  assert.equal(invalid.ready, true, 'ordinary contextual chat remains available');
  assert.equal(invalid.sessionStorageReady, false);
  assert.ok(invalid.sessionMissing.includes('CHAT_SESSION_PLAN_POLICIES'));

  // The old per-tier variable configures nothing any more: a stale deployment is not silently "ready".
  const original = console.warn;
  console.warn = () => {};
  try {
    const stale = loadContextualFeatureConfig({
      ...base,
      CHAT_SESSION_TIER_POLICIES: JSON.stringify({ super: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 } }),
    });
    assert.deepEqual(stale.sessionPlanPolicies, {});
    assert.equal(stale.sessionStorageReady, false);
  } finally {
    console.warn = original;
  }
});

test('membership tier: a single claim goes through the SDK; a group list takes the highest tier', () => {
  const claim = 'custom:subscriptionTier';
  for (const info of SUBSCRIPTION_TIERS) {
    assert.equal(resolveMembershipTier({ [claim]: info.wire }, claim), info.wire, info.wire);
    assert.equal(resolveMembershipTier({ [claim]: ` ${info.displayName.toLowerCase()} ` }, claim), info.wire, info.displayName);
  }
  assert.equal(resolveMembershipTier({}, claim), SubscriptionTier.MUST, 'missing: Must');
  assert.equal(resolveMembershipTier({ 'cognito:groups': ['staff', 'SUPER', 'INFINITY'] }, 'cognito:groups'), SubscriptionTier.INFINITY);
  assert.equal(resolveMembershipTier({ 'cognito:groups': ['staff'] }, 'cognito:groups'), SubscriptionTier.MUST);
  assert.equal(resolveMembershipTier({ [claim]: { value: 'SUPER' } }, claim), SubscriptionTier.MUST);
});

test('an unknown single tier claim is treated as Must and logged as an error', () => {
  const original = console.error;
  const logged: unknown[] = [];
  console.error = (e: unknown) => { logged.push(e); };
  try {
    assert.equal(resolveMembershipTier({ 'custom:subscriptionTier': 'NOT_A_TIER' }, 'custom:subscriptionTier'), SubscriptionTier.MUST);
    assert.equal(resolveMembershipTier({}, 'custom:subscriptionTier'), SubscriptionTier.MUST); // missing: silent
    assert.equal(resolveMembershipTier({ 'cognito:groups': ['staff'] }, 'cognito:groups'), SubscriptionTier.MUST); // groups: silent
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]), /UnknownSubscriptionTier: token tier 'NOT_A_TIER' treated as Must/);
});

test('Pro config: included tiers come from config, prices default to Rs 799 / Rs 5,999, the fake provider is refused in prod', () => {
  const pro = (extra: Record<string, string>) => loadContextualFeatureConfig({ MR_ONEHOOK_PRO_ENABLED: 'true', ...extra } as NodeJS.ProcessEnv).pro;
  assert.deepEqual(pro({ MR_ONEHOOK_PRO_INCLUDED_TIERS: 'infinity, not-a-tier' }).includedTiers, [SubscriptionTier.INFINITY]);
  assert.deepEqual(pro({}).prices, { MONTHLY: 79_900, YEARLY: 599_900 });
  assert.deepEqual(pro({ MR_ONEHOOK_PRO_PRICES: '{"monthly":69900,"yearly":-1}' }).prices, { MONTHLY: 69_900, YEARLY: 599_900 });
  assert.equal(pro({ MR_ONEHOOK_PRO_PAYMENT_PROVIDER: 'fake', ONEHOOK_STAGE: 'gamma' }).paymentProvider, 'fake');
  const prod = pro({ MR_ONEHOOK_PRO_PAYMENT_PROVIDER: 'fake', ONEHOOK_STAGE: 'prod' });
  assert.equal(prod.paymentProvider, 'none');
  assert.ok(prod.missing.some((m) => m.includes('refused')));
  assert.equal(pro({ MR_ONEHOOK_PRO_PAYMENT_PROVIDER: 'fake' }).paymentProvider, 'none', 'no stage: refused');
});

test('normalizeTier is exactly the onehook-api-client parser', () => {
  for (const raw of ['SUPER', 'super', ' Infinity ', 'must', 'NOT_A_TIER', '', undefined, 42]) {
    assert.equal(normalizeTier(raw), parseSubscriptionTier(raw));
  }
});

test('session persistence is explicit and session IDs must be UUIDs', () => {
  const sessionId = '0199a7a2-4df0-7d31-8a67-89abcdef0123';
  const created = parseContextualChatInput({
    matchId: 'match-1',
    message: 'hello',
    sessionOptions: { persist: true },
  }, 100);
  assert.equal(created.persistSession, true);
  assert.equal(created.sessionId, undefined);

  const continued = parseContextualChatInput({
    matchId: 'match-1',
    message: 'again',
    sessionOptions: { sessionId },
  }, 100);
  assert.equal(continued.persistSession, true);
  assert.equal(continued.sessionId, sessionId);
  assert.throws(() => parseContextualChatInput({
    matchId: 'match-1',
    message: 'bad',
    sessionOptions: { persist: true, sessionId: 'not-a-uuid' },
  }, 100));
  assert.throws(() => parseContextualChatInput({
    matchId: 'match-1',
    message: 'bad',
    sessionOptions: { persist: false, sessionId },
  }, 100));
});

test('member product-only requests omit match context cleanly', () => {
  const input = parseContextualChatInput({
    message: 'What does OneHook offer?',
    contextOptions: { includeProfile: true, includeMessageHistory: true },
  }, 100);
  assert.deepEqual(input, {
    message: 'What does OneHook offer?',
    includeProfile: true,
    includeMessageHistory: true,
    persistSession: false,
    attachmentIds: [],
  });
  assert.equal('matchId' in input, false);
  assert.throws(() => parseContextualChatInput({ message: 'hello', matchId: '' }, 100));
});

test('ephemeral message context is bounded and requires an authorized match scope', () => {
  const contextRequestId = '33333333-3333-4333-8333-333333333333';
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const input = parseContextualChatInput({
    matchId: 'match-1',
    message: 'What did they say about travel?',
    contextRequestId,
    ephemeralMessageContext: {
      excerpts: [{ speaker: 'match', sentAt, text: 'I would like to visit Japan.' }],
      historyTruncated: true,
      userConfirmed: true,
    },
  }, 100, 3, 100);
  assert.equal(input.contextRequestId, contextRequestId);
  assert.deepEqual(input.ephemeralMessageContext, {
    excerpts: [{ speaker: 'match', sentAt, text: 'I would like to visit Japan.' }],
    historyTruncated: true,
    userConfirmed: true,
  });

  assert.throws(() => parseContextualChatInput({
    message: 'No match scope',
    ephemeralMessageContext: { excerpts: [{ speaker: 'self', sentAt, text: 'hello' }] },
  }, 100));
  assert.throws(() => parseContextualChatInput({
    matchId: 'match-1',
    message: 'Invalid speaker',
    ephemeralMessageContext: { excerpts: [{ speaker: 'other', sentAt, text: 'hello' }] },
  }, 100));
  assert.throws(() => parseContextualChatInput({
    matchId: 'match-1',
    message: 'Future message',
    ephemeralMessageContext: {
      excerpts: [{ speaker: 'self', sentAt: new Date(Date.now() + 600_000).toISOString(), text: 'hello' }],
    },
  }, 100));
  assert.throws(() => parseContextualChatInput({
    matchId: 'match-1',
    message: 'History disabled',
    contextOptions: { includeMessageHistory: false },
    ephemeralMessageContext: { excerpts: [{ speaker: 'self', sentAt, text: 'hello' }] },
  }, 100));
  assert.throws(() => parseContextualChatInput({
    matchId: 'match-1',
    message: 'Too many',
    ephemeralMessageContext: {
      excerpts: [
        { speaker: 'self', sentAt, text: 'one' },
        { speaker: 'match', sentAt, text: 'two' },
      ],
    },
  }, 100, 1, 100));
  assert.throws(() => parseContextualChatInput({
    matchId: 'match-1',
    message: 'Too large',
    ephemeralMessageContext: { excerpts: [{ speaker: 'self', sentAt, text: 'x'.repeat(20) }] },
  }, 100, 3, 10));
});
