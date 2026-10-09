import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPermissions, resolveSessionTier } from '../auth';
import { loadContextualFeatureConfig } from '../contextConfig';
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
    AZURE_STORAGE_ACCOUNT: 'storage',
    AZURE_SESSION_CONTAINER: 'aisessions',
    EPHEMERAL_CONTEXT_MAX_MESSAGES: '500',
  });
  assert.equal(config.ready, true);
  assert.equal(config.oneHookDataApiUrl, 'https://data.example');
  assert.equal(config.maxEphemeralMessages, 30, 'out-of-range limits use the safe default');
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
    AZURE_STORAGE_ACCOUNT: 'storage',
    AZURE_SESSION_CONTAINER: 'aisessions',
    CHAT_SESSION_STORAGE_ENABLED: 'true',
  };
  const valid = loadContextualFeatureConfig({
    ...base,
    CHAT_SESSION_TIER_POLICIES: JSON.stringify({
      Premium: { enabled: true, maxSessions: 10, maxMessages: 50, retentionDays: 30 },
      free: { enabled: false, maxSessions: 1, maxMessages: 2, retentionDays: 1 },
    }),
  });
  assert.equal(valid.sessionStorageReady, true);
  assert.deepEqual(valid.sessionTierPolicies, {
    premium: { maxSessions: 10, maxMessages: 50, retentionDays: 30 },
  });

  const invalid = loadContextualFeatureConfig({
    ...base,
    CHAT_SESSION_TIER_POLICIES: '{bad-json',
  });
  assert.equal(invalid.ready, true, 'ordinary contextual chat remains available');
  assert.equal(invalid.sessionStorageReady, false);
  assert.ok(invalid.sessionMissing.includes('CHAT_SESSION_TIER_POLICIES'));
});

test('Cognito tier resolution supports custom claims and configured groups only', () => {
  const tiers = { plus: {}, premium: {} };
  assert.equal(resolveSessionTier({ 'custom:tier': ' Premium ' }, 'custom:tier', tiers), 'premium');
  assert.equal(resolveSessionTier({ 'cognito:groups': ['staff', 'plus'] }, 'cognito:groups', tiers), 'plus');
  assert.equal(resolveSessionTier({ 'custom:tier': 'free' }, 'custom:tier', tiers), undefined);
  assert.equal(resolveSessionTier({ 'custom:tier': { value: 'premium' } }, 'custom:tier', tiers), undefined);
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
