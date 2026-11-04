import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createContextualRouter } from '../contextRoutes';
import { loadContextualFeatureConfig } from '../contextConfig';
import { parseContextualChatInput } from '../contextTypes';

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

async function withServer(run: (send: (tier: string, options: Record<string, unknown>) => Promise<{ status: number; body: any }>, modelCalls: () => number, sessions: Map<string, unknown>) => Promise<void>) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((ok) => jwks.listen(0, ok));
  const config = loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true', AUTH_ISSUER: 'https://issuer.test', AUTH_AUDIENCE: 'aud',
    AUTH_JWKS_URI: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`,
    CORS_ALLOWED_ORIGINS: 'https://x', ONEHOOK_DATA_API_URL: 'https://data', AZURE_STORAGE_ACCOUNT: 'acct',
    AZURE_SESSION_CONTAINER: 'c', ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1', CHAT_SESSION_STORAGE_ENABLED: 'true',
    CHAT_SESSION_TIER_POLICIES: JSON.stringify({
      super: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 },
      infinity: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 },
    }),
  } as NodeJS.ProcessEnv);
  let calls = 0;
  const client = { chat: { completions: { create: async () => { calls++; return { choices: [{ message: { content: JSON.stringify({ reply: 'hi', mood: 'Happy' }) } }] }; } } } };
  const { store, sessions } = memoryStore();
  const app = express();
  app.use(express.json());
  app.use(createContextualRouter(config, {
    client: client as never, deployment: 'd', dataClient: {} as never, sessionStore: store as never,
    productContextProvider: async () => '',
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (tier: string, sessionOptions: Record<string, unknown>) => {
    const jwt = await new SignJWT({ 'custom:subscriptionTier': tier })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('member-1')
      .setIssuer('https://issuer.test').setAudience('aud').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const r = await fetch(`${base}/api/member/product-connection-chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ message: 'hello', sessionOptions }),
    });
    return { status: r.status, body: await r.json() };
  };
  try { await run(send, () => calls, sessions); } finally { server.close(); jwks.close(); }
}

test('Super and Infinity: at most 3 saved sessions; a 4th is refused before the model call, listing them', async () => {
  for (const tier of ['SUPER', 'INFINITY']) {
    await withServer(async (send, modelCalls, sessions) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await send(tier, { persist: true });
        assert.equal(r.status, 200);
        ids.push(r.body.session.sessionId);
      }
      const before = modelCalls();
      const fourth = await send(tier, { persist: true });
      assert.equal(fourth.status, 409);
      assert.equal(fourth.body.error, 'CHAT_SESSION_LIMIT_REACHED');
      assert.equal(fourth.body.maxSessions, 3);
      assert.deepEqual(fourth.body.sessions.map((s: { sessionId: string }) => s.sessionId).sort(), [...ids].sort());
      assert.equal(modelCalls(), before, 'no model call when refused');
      assert.equal(sessions.size, 3);

      // Continuing an existing session is never blocked by the cap, and messages are unlimited.
      for (let i = 0; i < 15; i++) assert.equal((await send(tier, { sessionId: ids[0] })).status, 200);
    });
  }
});

test('replaceLeastRecent: deletes only the least recently active session, then starts the new one', async () => {
  await withServer(async (send, _calls, sessions) => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await send('SUPER', { persist: true })).body.session.sessionId);
    await send('SUPER', { sessionId: ids[0] }); // ids[0] is now the most recent; ids[1] the least recent
    const r = await send('SUPER', { persist: true, replaceLeastRecent: true });
    assert.equal(r.status, 200);
    assert.equal(sessions.size, 3);
    assert.ok(!sessions.has(ids[1]!), 'least recently active session replaced');
    assert.ok(sessions.has(ids[0]!) && sessions.has(ids[2]!) && sessions.has(r.body.session.sessionId));
  });
});

test('member deletes a session themselves, then can start a new one', async () => {
  await withServer(async (send, _calls, sessions) => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await send('SUPER', { persist: true })).body.session.sessionId);
    sessions.delete(ids[2]!);
    assert.equal((await send('SUPER', { persist: true })).status, 200);
  });
});

test('Must: no saved sessions', async () => {
  await withServer(async (send) => {
    const r = await send('MUST', { persist: true });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'CHAT_SESSION_NOT_INCLUDED_IN_TIER');
  });
});

test('replaceLeastRecent must be a boolean', () => {
  assert.throws(() => parseContextualChatInput({ message: 'hi', sessionOptions: { persist: true, replaceLeastRecent: 'yes' } }, 2000, 20, 4000));
  assert.equal(parseContextualChatInput({ message: 'hi', sessionOptions: { persist: true, replaceLeastRecent: true } }, 2000, 20, 4000).replaceLeastRecent, true);
  void randomUUID;
});
