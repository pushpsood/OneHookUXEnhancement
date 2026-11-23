import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createContextualRouter } from '../contextRoutes';
import { loadContextualFeatureConfig } from '../contextConfig';
import { parseContextualChatInput } from '../contextTypes';
import { ProStore } from '../proStore';
import { ProSubscriptionService } from '../proSubscriptionService';
import { FakeProPaymentProvider } from '../proPayments';
import { unavailableMembershipDirectory } from '../membershipDirectory';
import { SubscriptionTier } from 'onehook-api-client';
import { MemoryProTable } from './helpers/memoryProTable';

/**
 * Saved sessions per plan: Free (Must and Super) keeps 1 (a new one replaces it), Pro keeps 3 (a new one
 * deletes the least recently active). Eviction happens only when the new session is saved, never on a
 * refused or failed turn; a member's own deletion frees a slot.
 */

/** In-memory session store with the PlaintextChatSessionStore shape the route uses. */
function memoryStore() {
  const sessions = new Map<string, { sessionId: string; updatedAt: string; createdAt: string; expiresAt: string; messages: unknown[] }>();
  let clock = Date.parse('2026-11-04T00:00:00Z');
  const store = {
    list: async () => [...sessions.values()]
      .map((s) => ({ sessionId: s.sessionId, scope: 'product', createdAt: s.createdAt, updatedAt: s.updatedAt, expiresAt: s.expiresAt, messageCount: s.messages.length }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    get: async (_s: string, id: string) => sessions.get(id),
    delete: async (_s: string, id: string) => { sessions.delete(id); },
    appendExchange: async (input: { sessionId?: string; exchangeId: string; userMessage: string; assistantMessage: string }) => {
      const id = input.sessionId ?? input.exchangeId;
      const at = new Date(clock += 60_000).toISOString();
      const prev = sessions.get(id);
      const s = { sessionId: id, createdAt: prev?.createdAt ?? at, updatedAt: at, expiresAt: at, messages: [...(prev?.messages ?? []), input.userMessage, input.assistantMessage] };
      sessions.set(id, s);
      return s;
    },
  };
  return { store, sessions };
}

type Send = (tier: string, options: Record<string, unknown>, message?: string) => Promise<{ status: number; body: any }>;

async function withServer(run: (ctx: { send: Send; modelCalls: () => number; quotaCalls: () => number; sessions: Map<string, unknown>; pro: ProSubscriptionService }) => Promise<void>) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((ok) => jwks.listen(0, ok));
  const config = loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true', AUTH_ISSUER: 'https://issuer.test', AUTH_AUDIENCE: 'aud',
    AUTH_JWKS_URI: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`,
    CORS_ALLOWED_ORIGINS: 'https://x', ONEHOOK_DATA_API_URL: 'https://data', AZURE_STORAGE_ACCOUNT: 'acct',
    AZURE_SESSION_CONTAINER: 'c', ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1', CHAT_SESSION_STORAGE_ENABLED: 'true',
    CHAT_SESSION_PLAN_POLICIES: JSON.stringify({
      free: { enabled: true, maxSessions: 1, maxMessages: 50, retentionDays: 30 },
      pro: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 },
    }),
    MR_ONEHOOK_PRO_INCLUDED_TIERS: 'infinity',
  } as NodeJS.ProcessEnv);
  let calls = 0;
  let quota = 0;
  const client = {
    chat: {
      completions: {
        create: async (params: { messages: Array<{ content: string }> }) => {
          calls++;
          const last = params.messages[params.messages.length - 1]?.content;
          const answer = last === 'need context'
            ? { reply: 'Which trip?', mood: 'Thinking', needsMoreContext: true, contextRequest: { searchTerms: ['trip'], maxMessages: 3 } }
            : { reply: 'hi', mood: 'Happy' };
          return { choices: [{ message: { content: JSON.stringify(answer) } }] };
        },
      },
    },
  };
  const { store, sessions } = memoryStore();
  const pro = new ProSubscriptionService({
    store: new ProStore(new MemoryProTable()), provider: new FakeProPaymentProvider(), directory: unavailableMembershipDirectory,
    includedTiers: config.pro.includedTiers, prices: config.pro.prices, currency: 'INR',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use(createContextualRouter(config, {
    client: client as never, deployment: 'd', dataClient: {} as never, sessionStore: store as never,
    chatQuota: { consume: async () => { quota++; return { allowed: true, remaining: 9 }; }, release: async () => {} },
    productContextProvider: async () => '', pro,
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send: Send = async (tier, sessionOptions, message = 'hello') => {
    const jwt = await new SignJWT({ 'custom:subscriptionTier': tier })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('member-1')
      .setIssuer('https://issuer.test').setAudience('aud').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const r = await fetch(`${base}/api/member/product-connection-chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ message, sessionOptions }),
    });
    return { status: r.status, body: await r.json() };
  };
  try { await run({ send, modelCalls: () => calls, quotaCalls: () => quota, sessions, pro }); } finally { server.close(); jwks.close(); }
}

test('Free plan (Must and Super): one saved session; a new one replaces it; messages use the daily allowance', async () => {
  for (const tier of ['MUST', 'SUPER']) {
    await withServer(async ({ send, quotaCalls, sessions }) => {
      const first = await send(tier, { persist: true });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.plan, 'FREE');
      assert.equal(first.body.evictedSessionIds, undefined);
      const second = await send(tier, { persist: true });
      assert.equal(second.status, 200);
      assert.deepEqual(second.body.evictedSessionIds, [first.body.session.sessionId]);
      assert.deepEqual([...sessions.keys()], [second.body.session.sessionId]);
      assert.equal(quotaCalls(), 2, `${tier} chats count against the daily allowance`);
    });
  }
});

test('Pro by membership: three saved sessions; a 4th deletes the least recently active one; no daily allowance', async () => {
  await withServer(async ({ send, quotaCalls, sessions }) => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await send('INFINITY', { persist: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.plan, 'PRO');
      ids.push(r.body.session.sessionId);
    }
    await send('INFINITY', { sessionId: ids[0] }); // ids[0] is now the most recent; ids[1] the least recent
    const fourth = await send('INFINITY', { persist: true });
    assert.equal(fourth.status, 200);
    assert.deepEqual(fourth.body.evictedSessionIds, [ids[1]]);
    assert.equal(sessions.size, 3);
    assert.ok(sessions.has(ids[0]!) && sessions.has(ids[2]!) && sessions.has(fourth.body.session.sessionId));
    // Continuing is never blocked, and messages are unlimited.
    for (let i = 0; i < 15; i++) assert.equal((await send('INFINITY', { sessionId: ids[0] })).status, 200);
    assert.equal(quotaCalls(), 0);
  });
});

test('Pro by subscription: a Super member who bought Pro gets three sessions and unlimited messages', async () => {
  await withServer(async ({ send, quotaCalls, sessions, pro }) => {
    await pro.purchase('member-1', SubscriptionTier.SUPER, { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' }, '11111111-1111-4111-8111-111111111111');
    for (let i = 0; i < 3; i++) assert.equal((await send('SUPER', { persist: true })).body.plan, 'PRO');
    assert.equal(sessions.size, 3);
    assert.equal(quotaCalls(), 0);
  });
});

test('a member who deleted a session has room: nothing else is deleted', async () => {
  await withServer(async ({ send, sessions }) => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await send('INFINITY', { persist: true })).body.session.sessionId);
    sessions.delete(ids[2]!);
    const r = await send('INFINITY', { persist: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.evictedSessionIds, undefined);
    assert.ok(sessions.has(ids[0]!) && sessions.has(ids[1]!));
  });
});

test('after a downgrade to Free, old sessions continue; the next new one trims down to one', async () => {
  await withServer(async ({ send, sessions }) => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await send('INFINITY', { persist: true })).body.session.sessionId);
    assert.equal((await send('SUPER', { sessionId: ids[1] })).status, 200, 'continuing an old session still works');
    const r = await send('SUPER', { persist: true });
    assert.equal(r.status, 200);
    assert.deepEqual([...r.body.evictedSessionIds].sort(), [...ids].sort());
    assert.deepEqual([...sessions.keys()], [r.body.session.sessionId]);
  });
});

test('a clarification (needsMoreContext) saves nothing and deletes nothing', async () => {
  await withServer(async ({ send, sessions }) => {
    const first = await send('MUST', { persist: true });
    const r = await send('MUST', { persist: true }, 'need context');
    assert.equal(r.status, 200);
    assert.equal(r.body.session, undefined);
    assert.equal(r.body.evictedSessionIds, undefined);
    assert.deepEqual([...sessions.keys()], [first.body.session.sessionId]);
  });
});

test('replaceLeastRecent is still accepted (deprecated) and must be a boolean', async () => {
  assert.throws(() => parseContextualChatInput({ message: 'hi', sessionOptions: { persist: true, replaceLeastRecent: 'yes' } }, 2000, 20, 4000));
  assert.doesNotThrow(() => parseContextualChatInput({ message: 'hi', sessionOptions: { persist: true, replaceLeastRecent: true } }, 2000, 20, 4000));
  await withServer(async ({ send }) => {
    assert.equal((await send('MUST', { persist: true, replaceLeastRecent: true })).status, 200);
  });
});
