import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { SubscriptionTier } from 'onehook-api-client';
import { createApp } from '../../app';
import { loadContextualFeatureConfig } from '../../contextConfig';
import { TableChatQuota, FREE_DAILY_MESSAGES } from '../../chatQuota';
import { PlaintextChatSessionStore, stableReference } from '../../plaintextChatSessionStore';
import { AzureProTable, ProStore, proPartitionKey } from '../../proStore';
import { ProSubscriptionService } from '../../proSubscriptionService';
import { FakeProPaymentProvider } from '../../proPayments';
import type { MembershipSnapshot } from '../../membershipDirectory';
import { AttachmentStore } from '../../attachmentStore';
import { AttachmentProcessingQueue, AttachmentProcessor } from '../../attachmentProcessor';
import { AttachmentUsageLedger } from '../../attachmentUsage';
import { ProHandoverWorker, HANDOVER_DETAIL_TYPE, HANDOVER_SOURCE } from '../../proHandoverWorker';
import { createUserDataEraser, type QueueMessage } from '../../uxErasureWorker';
import { manualClock } from '../helpers/memoryProTable';

/**
 * Mr OneHook Pro end to end: the real HTTP app (createApp) on real Azure Storage semantics (Azurite:
 * conditional blob writes, Table ETags, Table queries across partitions). Only the edges are stand-ins:
 * the AI model, the payment provider (the fake one), and State (a fake membership directory; the real client
 * is covered by stateMembershipClient.test.ts). Run with `npm run test:e2e`.
 */
const connection = process.env.AZURITE_CONNECTION_STRING;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');

test('Mr OneHook Pro: Free -> Pro -> membership -> keep Pro, on real storage', { skip: !connection }, async () => {
  const blobService = BlobServiceClient.fromConnectionString(connection!);
  const container = blobService.getContainerClient(`aisessions${Date.now()}`);
  await container.create();
  const tableOptions = { allowInsecureConnection: true };
  const proTableName = `mronehookpro${Date.now()}`;
  const quotaTableName = `chatquota${Date.now()}`;
  const proTableClient = TableClient.fromConnectionString(connection!, proTableName, tableOptions);
  const quotaTableClient = TableClient.fromConnectionString(connection!, quotaTableName, tableOptions);
  await proTableClient.createTable();
  await quotaTableClient.createTable();

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((ok) => jwks.listen(0, '127.0.0.1', ok));

  const config = loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true', AUTH_ISSUER: 'https://issuer.test', AUTH_AUDIENCE: 'aud',
    AUTH_JWKS_URI: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`,
    CORS_ALLOWED_ORIGINS: 'https://app.test', ONEHOOK_DATA_API_URL: 'https://state.test', AZURE_STORAGE_ACCOUNT: 'devstoreaccount1',
    AZURE_SESSION_CONTAINER: container.containerName, ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1',
    AZURE_CHAT_QUOTA_TABLE: quotaTableName, CHAT_SESSION_STORAGE_ENABLED: 'true',
    CHAT_SESSION_PLAN_POLICIES: JSON.stringify({
      free: { enabled: true, maxSessions: 1, maxMessages: 50, retentionDays: 30 },
      pro: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 },
    }),
    MR_ONEHOOK_PRO_ENABLED: 'true', MR_ONEHOOK_PRO_INCLUDED_TIERS: 'infinity', AZURE_PRO_TABLE: proTableName,
    MR_ONEHOOK_PRO_PAYMENT_PROVIDER: 'fake', ONEHOOK_STAGE: 'e2e', CHAT_ATTACHMENTS_ENABLED: 'true',
    // Membership-included Pro gets a tiny allowance here so the overuse refusal can be seen.
    ATTACHMENT_MONTHLY_BUDGET_MINOR: JSON.stringify({ subscription: 40_000, membership: 2 }),
  } as NodeJS.ProcessEnv);
  assert.ok(config.ready && config.pro.ready && config.attachments.ready, 'fully configured');

  // ── The edges ──
  const state = new Map<string, MembershipSnapshot>();
  const confirmed: string[] = [];
  const directory = {
    get: async (userId: string) => state.get(userId) ?? { tier: SubscriptionTier.SUPER },
    confirmProHandover: async (_userId: string, activationId: string) => { confirmed.push(activationId); },
  };
  const provider = new FakeProPaymentProvider();
  const clock = manualClock(new Date().toISOString());
  const prompts: string[] = [];
  const model = {
    chat: {
      completions: {
        create: async (p: { messages: Array<{ content: string }> }) => {
          prompts.push(p.messages[0]!.content);
          return { choices: [{ message: { content: JSON.stringify({ reply: 'Happy to help.', mood: 'Happy' }) } }] };
        },
      },
    },
  };
  const readers = {
    vision: { describe: async () => ({ text: 'A cafe menu. TEXT: Filter coffee 60', inputTokens: 900, outputTokens: 80 }) },
    transcriber: { transcribe: async () => ({ text: 'Voice note: running late', seconds: 30 }) },
  };

  // ── The real stores and services, as index.ts wires them ──
  const proStore = new ProStore(new AzureProTable(proTableClient));
  const pro = new ProSubscriptionService({
    store: proStore, provider, directory, includedTiers: config.pro.includedTiers, prices: config.pro.prices,
    currency: config.pro.currency, now: clock.now, logger: quiet,
  });
  const attachmentStore = new AttachmentStore(container);
  const sessionStore = new PlaintextChatSessionStore(container, {
    onSessionDeleted: async (subject, ids) => { for (const id of ids) await attachmentStore.delete(subject, id); },
  });
  const processor = new AttachmentProcessor(readers, config.attachments.rates, config.attachments.maxDocumentPages);
  const usage = new AttachmentUsageLedger(proStore, config.attachments);
  const queue = new AttachmentProcessingQueue(attachmentStore, processor, usage, 2, quiet);
  const chatQuota = new TableChatQuota(quotaTableClient);
  const server = createApp({
    corsAllowedOrigins: ['https://app.test'], contextualConfig: config,
    publicChat: { client: model as never, deployment: 'd', productContextProvider: async () => 'product' },
    contextualServices: {
      client: model as never, deployment: 'd', dataClient: {} as never, sessionStore, chatQuota,
      productContextProvider: async () => 'product', pro, attachments: { store: attachmentStore, processor, usage, queue },
    },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((ok) => (server.listening ? ok() : server.once('listening', ok)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tokens = new Map<string, string>();
  const tierOf = new Map<string, string>();
  const auth = async (who: string) => {
    const tier = tierOf.get(who) ?? 'SUPER';
    const cacheKey = `${who}:${tier}`;
    if (!tokens.has(cacheKey)) {
      tokens.set(cacheKey, await new SignJWT({ 'custom:subscriptionTier': tier })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(who).setIssuer('https://issuer.test').setAudience('aud')
        .setIssuedAt().setExpirationTime('30m').sign(privateKey));
    }
    return `Bearer ${tokens.get(cacheKey)}`;
  };
  const api = async (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: await auth(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const chat = (who: string, body: Record<string, unknown>) => api(who, 'POST', '/api/member/product-connection-chat', body);
  const upload = async (who: string, bytes: Uint8Array, name: string, type: string) => {
    const r = await fetch(`${base}/api/member/product-connection-chat/attachments`, {
      method: 'POST', headers: { authorization: await auth(who), 'content-type': type, 'x-attachment-name': encodeURIComponent(name) },
      body: new Blob([new Uint8Array(bytes)]),
    });
    return { status: r.status, body: await r.json() as any };
  };
  const waitReady = async (who: string, id: string) => {
    for (let i = 0; i < 50; i++) {
      const r = await api(who, 'GET', `/api/member/product-connection-chat/attachments/${id}`);
      if (r.body.attachment?.status !== 'PROCESSING') return r.body.attachment;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    throw new Error('attachment never finished');
  };
  const proView = (who: string) => api(who, 'GET', '/api/member/mr-onehook-pro');
  const blobsOf = async (who: string) => {
    const names: string[] = [];
    for await (const b of container.listBlobsFlat()) if (b.name.includes(stableReference(who))) names.push(b.name);
    return names;
  };
  // Fresh member ids per run. Each member stays under the 20 requests per minute of the member routes.
  const run = randomUUID().slice(0, 8);
  const member = (name: string) => `${name}-${run}`;

  try {
    // ── 1. Ravi, a Super member, is on the Free plan ──────────────────────────
    const ravi = member('ravi');
    const first = await chat(ravi, { message: 'hi', sessionOptions: { persist: true } });
    assert.deepEqual([first.status, first.body.plan, first.body.remainingMessages], [200, 'FREE', FREE_DAILY_MESSAGES - 1]);
    const second = await chat(ravi, { message: 'new topic', sessionOptions: { persist: true } });
    assert.deepEqual(second.body.evictedSessionIds, [first.body.session.sessionId], 'a new session replaces the last one');
    assert.equal((await api(ravi, 'GET', '/api/member/product-connection-chat/sessions')).body.sessions.length, 1);
    const counted = member('counted');
    for (let i = 1; i <= FREE_DAILY_MESSAGES; i++) assert.equal((await chat(counted, { message: `m${i}` })).status, 200);
    assert.equal((await chat(counted, { message: 'one more' })).body.error, 'MESSAGE_LIMIT_REACHED', 'Free: 10 per UTC day (real Table counter)');
    const freeView = await proView(ravi);
    assert.deepEqual([freeView.body.plan, freeView.body.canPurchase, freeView.body.offers.map((o: { priceMinor: number }) => o.priceMinor)],
      ['FREE', true, [79_900, 599_900]]);
    assert.equal((await upload(ravi, PNG, 'menu.png', 'image/png')).body.error, 'PRO_REQUIRED');

    // ── 2. Ravi buys Pro (monthly); two taps at once charge once ──────────────
    const [a, b] = await Promise.all([
      api(ravi, 'POST', '/api/member/mr-onehook-pro/subscription', { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' }, { 'idempotency-key': randomUUID() }),
      api(ravi, 'POST', '/api/member/mr-onehook-pro/subscription', { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' }, { 'idempotency-key': randomUUID() }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'one purchase wins on the ETag');
    assert.equal(provider.succeededCharges().length, 1);
    const unlimited = await chat(ravi, { message: 'now unlimited?' });
    assert.deepEqual([unlimited.status, unlimited.body.plan, unlimited.body.remainingMessages], [200, 'PRO', undefined]);

    // ── 3. Pro: three sessions, LRU replaced; files read and kept with the session ──
    const raviPro = member('ravi-pro');
    tierOf.set(raviPro, 'SUPER');
    await pro.purchase(raviPro, SubscriptionTier.SUPER, { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' }, randomUUID());
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await chat(raviPro, { message: `topic ${i}`, sessionOptions: { persist: true } })).body.session.sessionId);
    await chat(raviPro, { message: 'back to the first', sessionOptions: { sessionId: ids[0] } });
    const fourth = await chat(raviPro, { message: 'topic 3', sessionOptions: { persist: true } });
    assert.deepEqual(fourth.body.evictedSessionIds, [ids[1]], 'the least recently active session went');
    const image = await upload(raviPro, PNG, 'menu.png', 'image/png');
    const note = await upload(raviPro, Buffer.from('Order: 2 coffees, 1 dosa'), 'order.txt', 'text/plain');
    assert.deepEqual([image.status, note.status], [202, 202]);
    assert.equal((await waitReady(raviPro, image.body.attachment.attachmentId)).status, 'READY');
    assert.equal((await waitReady(raviPro, note.body.attachment.attachmentId)).status, 'READY');
    const withFiles = await chat(raviPro, {
      message: 'what does the menu say?', sessionOptions: { sessionId: ids[0] },
      attachmentIds: [image.body.attachment.attachmentId, note.body.attachment.attachmentId],
    });
    assert.equal(withFiles.body.contextUsed.attachmentCount, 2);
    assert.match(prompts.at(-1)!, /Filter coffee 60[\s\S]*2 coffees, 1 dosa/);
    const followUp = await chat(raviPro, { message: 'and the price?', sessionOptions: { sessionId: ids[0] } });
    assert.equal(followUp.status, 200);
    assert.match(prompts.at(-1)!, /"files":\[\{"name":"menu.png","kind":"image","excerpt":"A cafe menu/, 'later turns still know the file');
    const reopened = await api(raviPro, 'GET', `/api/member/product-connection-chat/sessions/${ids[0]}`);
    const sent = reopened.body.session.messages.find((m: { attachments?: unknown[] }) => m.attachments);
    assert.deepEqual(sent.attachments.map((x: { name: string }) => x.name), ['menu.png', 'order.txt']);
    const content = await fetch(`${base}/api/member/product-connection-chat/attachments/${note.body.attachment.attachmentId}/content`, { headers: { authorization: await auth(raviPro) } });
    assert.deepEqual([content.status, await content.text(), content.headers.get('x-content-type-options')], [200, 'Order: 2 coffees, 1 dosa', 'nosniff']);
    assert.ok((await blobsOf(raviPro)).some((n) => n.startsWith('attachments/saved/')));
    await api(raviPro, 'DELETE', `/api/member/product-connection-chat/sessions/${ids[0]}`);
    assert.ok(!(await blobsOf(raviPro)).some((n) => n.startsWith('attachments/')), 'deleting the session deleted its files');

    // ── 4. Ravi buys the membership that includes Pro: handover, confirm, no more charges ──
    const handovers: QueueMessage[] = [{
      messageId: 'msg-1', receiptHandle: 'rh-1', receiveCount: 1,
      body: JSON.stringify({ id: 'evt-ravi-1', source: HANDOVER_SOURCE, 'detail-type': HANDOVER_DETAIL_TYPE, detail: { userId: ravi, activationId: 'act-ravi-1' } }),
    }];
    const acked: string[] = [];
    const worker = new ProHandoverWorker({
      receive: async () => handovers.splice(0), delete: async (h) => { acked.push(h); }, release: async () => {},
    }, pro, quiet);
    assert.deepEqual(await worker.pollOnce(), ['settled']);
    assert.deepEqual([confirmed, acked], [['act-ravi-1'], ['rh-1']]);
    state.set(ravi, { tier: SubscriptionTier.INFINITY });
    tierOf.set(ravi, 'INFINITY'); // the app refreshes the token after State finalizes
    const memberView = await proView(ravi);
    assert.deepEqual([memberView.body.plan, memberView.body.source, memberView.body.canPurchase, memberView.body.subscription.pausedForMembership],
      ['PRO', 'MEMBERSHIP', false, true]);
    assert.ok(memberView.body.notices.some((n: { kind: string }) => n.kind === 'PRO_PAUSED_FOR_MEMBERSHIP'));
    assert.equal((await api(ravi, 'POST', '/api/member/mr-onehook-pro/subscription', { billingPeriod: 'YEARLY' }, { 'idempotency-key': randomUUID() })).body.error,
      'PRO_INCLUDED_IN_MEMBERSHIP');
    clock.advance(32 * DAY); // past the paid month; the job runs (Table query across partitions)
    await pro.runDue();
    const ended = await proView(ravi);
    assert.deepEqual([ended.body.subscription.status, ended.body.subscription.endedReason], ['ENDED', 'INCLUDED_IN_MEMBERSHIP']);
    const raviCharges = () => provider.succeededCharges().filter((c) => c.userId === ravi).map((c) => `${c.kind}:${c.amountMinor}`);
    assert.deepEqual(raviCharges(), ['PURCHASE:79900'], 'never renewed while the membership covered Pro');

    // ── 5. Ravi cancels the membership and keeps Pro (yearly); it ends early ──
    const endsAt = new Date(clock.now().getTime() + 20 * DAY).toISOString();
    state.set(ravi, { tier: SubscriptionTier.INFINITY, endsAt });
    const kept = await api(ravi, 'PUT', '/api/member/mr-onehook-pro/continuation', { billingPeriod: 'YEARLY', paymentToken: 'fake-ok' }, { 'idempotency-key': randomUUID() });
    assert.deepEqual([kept.status, kept.body.subscription.status, kept.body.subscription.scheduledStartAt], [200, 'SCHEDULED', endsAt]);
    clock.advance(5 * DAY);
    state.set(ravi, { tier: SubscriptionTier.SUPER, lastEnded: { at: clock.now().toISOString(), reason: 'PAYMENT_FAILED', tier: SubscriptionTier.INFINITY } });
    tierOf.set(ravi, 'SUPER');
    const grace = await proView(ravi);
    assert.deepEqual([grace.body.plan, grace.body.source], ['PRO', 'COMPLIMENTARY'], 'free Pro until the original end date');
    await pro.runDue();
    assert.deepEqual(raviCharges(), ['PURCHASE:79900'], 'nothing charged before the original end date');
    clock.set(new Date(Date.parse(endsAt) + 1000).toISOString());
    await pro.runDue();
    assert.deepEqual(raviCharges(), ['PURCHASE:79900', 'PURCHASE:599900'], 'first yearly charge on the original end date');
    assert.deepEqual([(await proView(ravi)).body.source, (await proView(ravi)).body.subscription.billingPeriod], ['SUBSCRIPTION', 'YEARLY']);

    // ── 6. Isha, whose membership includes Pro: files work, overuse is refused ──
    const isha = member('isha');
    tierOf.set(isha, 'INFINITY');
    assert.equal((await upload(isha, PNG, 'one.png', 'image/png')).status, 429, 'Rs 0.02 allowance: even one image is over it');
    const over = await upload(isha, PNG, 'two.png', 'image/png');
    assert.deepEqual([over.body.error, typeof over.body.retryAt], ['ATTACHMENT_PROCESSING_UNAVAILABLE', 'string']);
    const text = await upload(isha, Buffer.from('plain text costs nothing to read'), 'n.txt', 'text/plain');
    assert.equal(text.status, 202, 'text files need no AI and fit any allowance');
    assert.equal(provider.charges.filter((c) => c.userId === isha).length, 0, 'never charged');

    // ── 7. The homepage chat never takes files ──
    const publicChat = await fetch(`${base}/api/public/product-chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], attachmentIds: [randomUUID()] }),
    });
    assert.equal(publicChat.status, 400);

    // ── 8. Account deletion erases everything of the member (accounting ledger kept) ──
    const eraser = createUserDataEraser(sessionStore, chatQuota, { attachments: attachmentStore, pro });
    await eraser.eraseUser(raviPro);
    assert.deepEqual(await blobsOf(raviPro), []);
    const left: string[] = [];
    for await (const e of proTableClient.listEntities<{ rowKey: string }>({ queryOptions: { filter: `PartitionKey eq '${proPartitionKey(raviPro)}'` } })) left.push(e.rowKey);
    assert.ok(left.length > 0 && left.every((k) => k.startsWith('ledger:')), `only ledger rows remain: ${left.join(', ')}`);
  } finally {
    server.close();
    jwks.close();
    await container.deleteIfExists().catch(() => undefined);
    await proTableClient.deleteTable().catch(() => undefined);
    await quotaTableClient.deleteTable().catch(() => undefined);
  }
});
