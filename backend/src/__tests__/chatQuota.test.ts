import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TableChatQuota, FREE_DAILY_MESSAGES, QuotaUnavailableError, utcDay, type QuotaTable } from '../chatQuota';
import { createContextualRouter } from '../contextRoutes';
import { loadContextualFeatureConfig } from '../contextConfig';

/** In-memory Table Storage with ETags, 409 on duplicate insert and 412 on a stale ETag. */
function fakeTable(opts: { failReads?: boolean } = {}) {
  const rows = new Map<string, { day: string; count: number; etag: string }>();
  let n = 0;
  const err = (statusCode: number) => Object.assign(new Error(`status ${statusCode}`), { statusCode });
  const table = {
    getEntity: async (pk: string) => {
      if (opts.failReads) throw err(500);
      const r = rows.get(pk);
      if (!r) throw err(404);
      return { partitionKey: pk, rowKey: 'daily', ...r };
    },
    createEntity: async (e: { partitionKey: string; day: string; count: number }) => {
      if (rows.has(e.partitionKey)) throw err(409);
      rows.set(e.partitionKey, { day: e.day, count: e.count, etag: `e${++n}` });
      return {};
    },
    updateEntity: async (e: { partitionKey: string; day: string; count: number }, _m: string, o: { etag: string }) => {
      const r = rows.get(e.partitionKey);
      if (!r || r.etag !== o.etag) throw err(412);
      rows.set(e.partitionKey, { day: e.day, count: e.count, etag: `e${++n}` });
      return {};
    },
  };
  return { table: table as unknown as QuotaTable, rows };
}

test('free tier: 10 messages per UTC day, then refused; a new UTC day resets', async () => {
  const { table } = fakeTable();
  const quota = new TableChatQuota(table);
  const day1 = new Date('2026-10-28T23:59:00Z');
  for (let i = 1; i <= FREE_DAILY_MESSAGES; i++) {
    assert.deepEqual(await quota.consume('m1', day1), { allowed: true, remaining: FREE_DAILY_MESSAGES - i });
  }
  assert.deepEqual(await quota.consume('m1', day1), { allowed: false, remaining: 0 });
  assert.equal((await quota.consume('m2', day1)).allowed, true, 'counters are per member');
  assert.deepEqual(await quota.consume('m1', new Date('2026-10-29T00:00:01Z')),
    { allowed: true, remaining: FREE_DAILY_MESSAGES - 1 });
  assert.equal(utcDay(day1), '2026-10-28');
});

test('concurrent messages can never exceed the limit (ETag-conditional writes)', async () => {
  const { table, rows } = fakeTable();
  const quota = new TableChatQuota(table);
  const now = new Date('2026-10-28T12:00:00Z');
  const results = await Promise.all(Array.from({ length: 25 }, () => quota.consume('m1', now).catch(() => null)));
  const allowed = results.filter((r) => r?.allowed).length;
  assert.ok(allowed <= FREE_DAILY_MESSAGES, `allowed ${allowed}`);
  assert.equal([...rows.values()][0]!.count, allowed, 'stored count equals granted messages');
});

test('release gives back a slot; the stored member key is hashed', async () => {
  const { table, rows } = fakeTable();
  const quota = new TableChatQuota(table);
  const now = new Date('2026-10-28T12:00:00Z');
  await quota.consume('member-raw-id', now);
  await quota.release('member-raw-id', now);
  const [key, row] = [...rows.entries()][0]!;
  assert.equal(row.count, 0);
  assert.ok(!key.includes('member-raw-id') && /^[0-9a-f]{64}$/.test(key));
});

test('a store failure is QuotaUnavailableError, never unlimited', async () => {
  const quota = new TableChatQuota(fakeTable({ failReads: true }).table);
  await assert.rejects(() => quota.consume('m1'), QuotaUnavailableError);
});

// ── Route: no group gate, free tier limited, paid unlimited ─────────────────

async function withServer(quotaTable: QuotaTable, run: (call: (tier: string | undefined) => Promise<{ status: number; body: any }>, modelCalls: () => number) => Promise<void>) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((ok) => jwks.listen(0, ok));
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`;
  const config = loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true', AUTH_ISSUER: 'https://issuer.test', AUTH_AUDIENCE: 'aud', AUTH_JWKS_URI: jwksUrl,
    CORS_ALLOWED_ORIGINS: 'https://x', ONEHOOK_DATA_API_URL: 'https://data', AZURE_STORAGE_ACCOUNT: 'acct',
    AZURE_SESSION_CONTAINER: 'c', ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1', AZURE_CHAT_QUOTA_TABLE: 'chatquota',
  } as NodeJS.ProcessEnv);
  let calls = 0;
  const client = { chat: { completions: { create: async () => { calls++; return { choices: [{ message: { content: JSON.stringify({ reply: 'hi', mood: 'Happy' }) } }] }; } } } };
  const app = express();
  app.use(express.json());
  app.use(createContextualRouter(config, {
    client: client as never, deployment: 'd', dataClient: {} as never, sessionStore: {} as never,
    productContextProvider: async () => '', chatQuota: new TableChatQuota(quotaTable),
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (tier: string | undefined) => {
    const jwt = await new SignJWT({ ...(tier ? { 'custom:subscriptionTier': tier } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(`member-${tier ?? 'none'}`)
      .setIssuer('https://issuer.test').setAudience('aud').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const r = await fetch(`${base}/api/member/product-connection-chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ message: 'hello' }),
    });
    return { status: r.status, body: await r.json() };
  };
  try { await run(call, () => calls); } finally { server.close(); jwks.close(); }
}

test('route: every member may chat (no group/permission gate); Must gets 10/day then 402; Super is unlimited', async () => {
  await withServer(fakeTable().table, async (call, modelCalls) => {
    const first = await call('MUST');
    assert.equal(first.status, 200, 'no context.chat permission needed');
    assert.equal(first.body.remainingMessages, FREE_DAILY_MESSAGES - 1);
    for (let i = 2; i <= FREE_DAILY_MESSAGES; i++) assert.equal((await call('MUST')).status, 200);
    const over = await call('MUST');
    assert.equal(over.status, 402);
    assert.equal(over.body.error, 'MESSAGE_LIMIT_REACHED');
    assert.equal(modelCalls(), FREE_DAILY_MESSAGES, 'the model is not called once the limit is reached');

    assert.equal((await call(undefined)).body.remainingMessages, FREE_DAILY_MESSAGES - 1, 'no tier claim = Must');
    const paid = await call('SUPER');
    assert.equal(paid.status, 200);
    assert.equal(paid.body.remainingMessages, undefined, 'paid tiers have no counter');
  });
});

test('route: free member gets 503 (not unlimited) when the counter store fails; paid unaffected', async () => {
  await withServer(fakeTable({ failReads: true }).table, async (call) => {
    const free = await call('MUST');
    assert.equal(free.status, 503);
    assert.equal(free.body.error, 'CHAT_TEMPORARILY_UNAVAILABLE');
    assert.equal((await call('INFINITY')).status, 200);
  });
});
