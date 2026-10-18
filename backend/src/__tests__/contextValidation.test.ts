import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPermissions, resolveSessionTier } from '../auth';
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
    ONEHOOK_DATA_API_SCOPE: 'api://data/.default',
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

  // Default (sigv4): a region is required; a scope is not.
  const sigv4Missing = loadContextualFeatureConfig(base);
  assert.equal(sigv4Missing.oneHookDataApiAuthMode, 'sigv4');
  assert.equal(sigv4Missing.ready, false);
  assert.ok(sigv4Missing.missing.includes('ONEHOOK_DATA_API_AWS_REGION'));

  const sigv4Ready = loadContextualFeatureConfig({ ...base, ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1' });
  assert.equal(sigv4Ready.ready, true);
  assert.equal(sigv4Ready.oneHookDataApiAwsService, 'execute-api');

  // Bearer mode: a scope is required; a region is not.
  const bearerMissing = loadContextualFeatureConfig({ ...base, ONEHOOK_DATA_API_AUTH_MODE: 'bearer' });
  assert.equal(bearerMissing.oneHookDataApiAuthMode, 'bearer');
  assert.equal(bearerMissing.ready, false);
  assert.ok(bearerMissing.missing.includes('ONEHOOK_DATA_API_SCOPE'));

  const bearerReady = loadContextualFeatureConfig({
    ...base,
    ONEHOOK_DATA_API_AUTH_MODE: 'bearer',
    ONEHOOK_DATA_API_SCOPE: 'api://data/.default',
  });
  assert.equal(bearerReady.ready, true);
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
    ONEHOOK_DATA_API_SCOPE: 'api://data/.default',
    ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1',
    AZURE_STORAGE_ACCOUNT: 'storage',
    AZURE_SESSION_CONTAINER: 'aisessions',
    AUTH_ALLOWED_ALGORITHMS: 'HS256',
  });
  assert.equal(config.ready, true);
  assert.deepEqual(config.authAlgorithms, ['RS256']);
});

test('session storage becomes ready only with a valid bounded tier policy', () => {
  const base = {
    CONTEXTUAL_AI_ENABLED: 'true',
    AUTH_ISSUER: 'https://issuer.example',
    AUTH_AUDIENCE: 'user-api',
    AUTH_JWKS_URI: 'https://issuer.example/jwks',
    CORS_ALLOWED_ORIGINS: 'https://app.example',
    ONEHOOK_DATA_API_URL: 'https://data.example',
    ONEHOOK_DATA_API_SCOPE: 'scope',
    ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1',
    AZURE_STORAGE_ACCOUNT: 'storage',
    AZURE_SESSION_CONTAINER: 'aisessions',
    CHAT_SESSION_STORAGE_ENABLED: 'true',
  };
  const valid = loadContextualFeatureConfig({
    ...base,
    // Keys may be SDK wire values OR display names — both normalize to the onehook-api-client
    // SubscriptionTier wire value. Super + Infinity get AI sessions; Must
    // is disabled, matching the membership matrix.
    CHAT_SESSION_TIER_POLICIES: JSON.stringify({
      Super: { enabled: true, maxSessions: 10, maxMessages: 50, retentionDays: 30 },
      INFINITY: { enabled: true, maxSessions: 25, maxMessages: 50, retentionDays: 30 },
      Must: { enabled: false, maxSessions: 1, maxMessages: 2, retentionDays: 1 },
    }),
  });
  assert.equal(valid.sessionStorageReady, true);
  assert.deepEqual(valid.sessionTierPolicies, {
    [SubscriptionTier.SUPER]: { maxSessions: 10, maxMessages: 50, retentionDays: 30 },
    [SubscriptionTier.INFINITY]: { maxSessions: 25, maxMessages: 50, retentionDays: 30 },
  });

  const invalid = loadContextualFeatureConfig({
    ...base,
    CHAT_SESSION_TIER_POLICIES: '{bad-json',
  });
  assert.equal(invalid.ready, true, 'ordinary contextual chat remains available');
  assert.equal(invalid.sessionStorageReady, false);
  assert.ok(invalid.sessionMissing.includes('CHAT_SESSION_TIER_POLICIES'));

  // A policy whose only key is an unrecognised tier (e.g. the old `premium`) normalizes to nothing,
  // so session storage is NOT ready — this is the exact mismatch that previously broke gating.
  const stale = loadContextualFeatureConfig({
    ...base,
    CHAT_SESSION_TIER_POLICIES: JSON.stringify({
      premium: { enabled: true, maxSessions: 10, maxMessages: 50, retentionDays: 30 },
    }),
  });
  assert.deepEqual(stale.sessionTierPolicies, {});
  assert.equal(stale.sessionStorageReady, false);
});

test('tier resolution maps SDK wire values and display names to the SubscriptionTier policy key', () => {
  // Policies keyed by SDK wire tiers (what the Terraform default `super`/`infinity` normalizes to).
  const tiers = { [SubscriptionTier.SUPER]: {}, [SubscriptionTier.INFINITY]: {} };
  const claim = 'custom:subscriptionTier';
  for (const info of SUBSCRIPTION_TIERS) {
    const expected = info.wire in tiers ? info.wire : undefined;
    // The real Cognito attribute carries the WIRE value; a stale client may carry the display name.
    assert.equal(resolveSessionTier({ [claim]: info.wire }, claim, tiers), expected, info.wire);
    assert.equal(resolveSessionTier({ [claim]: ` ${info.displayName.toLowerCase()} ` }, claim, tiers), expected, info.displayName);
  }
});

test('unknown tier names never resolve, whatever the claim shape', () => {
  const tiers = { [SubscriptionTier.SUPER]: {}, [SubscriptionTier.INFINITY]: {} };
  for (const unknown of ['NOT_A_TIER', 'staff']) {
    assert.equal(resolveSessionTier({ 'custom:tier': unknown }, 'custom:tier', tiers), undefined, unknown);
  }
  assert.equal(resolveSessionTier({ 'cognito:groups': ['staff', 'SUPER'] }, 'cognito:groups', tiers), SubscriptionTier.SUPER);
  assert.equal(resolveSessionTier({ 'custom:tier': { value: 'SUPER' } }, 'custom:tier', tiers), undefined);
});

test('an unknown single tier claim is treated as Must and logged as an error', () => {
  const tiers = { [SubscriptionTier.SUPER]: {}, [SubscriptionTier.INFINITY]: {} };
  const original = console.error;
  const logged: unknown[] = [];
  console.error = (e: unknown) => { logged.push(e); };
  try {
    assert.equal(resolveSessionTier({ 'custom:subscriptionTier': 'NOT_A_TIER' }, 'custom:subscriptionTier', tiers), undefined);
    assert.equal(resolveSessionTier({}, 'custom:subscriptionTier', tiers), undefined); // missing: silent
    assert.equal(resolveSessionTier({ 'cognito:groups': ['staff'] }, 'cognito:groups', tiers), undefined); // groups: silent
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]), /UnknownSubscriptionTier: token tier 'NOT_A_TIER' treated as Must/);
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
