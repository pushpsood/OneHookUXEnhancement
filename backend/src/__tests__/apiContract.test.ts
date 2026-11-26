import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { API_OPERATIONS } from '../generated/apiManifest';
import { API_OPERATIONS as MR_ONEHOOK_OPERATIONS } from '../generated/mrOneHookApiManifest';
import { createApp } from '../app';
import { loadContextualFeatureConfig } from '../contextConfig';
import { QuotaUnavailableError } from '../chatQuota';
import { ChatSessionAccessError, type ChatSession, type StoredAttachmentRef } from '../plaintextChatSessionStore';
import { MatchContextAccessError, MatchContextUnavailableError } from '../oneHookDataClient';
import { SubscriptionTier } from 'onehook-api-client';
import { MembershipUnavailableError, type MembershipSnapshot } from '../membershipDirectory';
import { ProStore } from '../proStore';
import { CONTINUATION_ROW, ProSubscriptionService } from '../proSubscriptionService';
import { FakeProPaymentProvider } from '../proPayments';
import { AttachmentStore } from '../attachmentStore';
import { AttachmentProcessingQueue, AttachmentProcessor } from '../attachmentProcessor';
import { AttachmentUsageLedger } from '../attachmentUsage';
import { stableReference } from '../plaintextChatSessionStore';
import { MemoryProTable } from './helpers/memoryProTable';
import { MemoryContainer } from './helpers/memoryContainer';
import {
  lex,
  normalizeTemplate,
  productionSources,
  scanSdkCalls,
  SDK_TRANSPORT_FILE,
  scanRoutes,
  type SourceFile,
} from './contract/sourceScan';
import {
  checkResponse,
  findOperation,
  loadOpenApi,
  openApiOperations,
  SIBLING_OPENAPI_PATH,
  siblingOpenApiPresent,
  VENDORED_OPENAPI_PATH,
} from './contract/openapi';

/**
 * API contract tests: this service against its own Smithy model (sdk/model/mr-onehook.smithy: the manifest
 * src/generated/mrOneHookApiManifest.ts and the OpenAPI copy in contract/, both written by the SDK's
 * manifest:sync) and, for outbound calls, the OneHook backend's manifest (src/generated/apiManifest.ts).
 *  (a) every Express route it registers is a `MrOneHookService` operation, and every operation has a route;
 *  (b) every outbound call is a OneHook operation with `auth: iam` (and is SigV4-signed);
 *  (c) every route's success and error bodies match the operation's declared responses.
 */


// ── (a) Routes ────────────────────────────────────────────────────────────────

test('(a) every registered Express route is a MrOneHookService operation, and every operation has a route', () => {
  const { routes, problems } = scanRoutes(productionSources());
  assert.deepEqual(problems, [], 'route registrations the scan cannot resolve');
  const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const declared = new Set(MR_ONEHOOK_OPERATIONS.map((op) => `${op.method} ${op.path}`));
  const notInManifest = routes
    .filter((r) => !declared.has(`${r.method} ${r.path}`))
    .map((r) => `${r.method} ${r.path} (${r.file}:${r.line})`);
  const withoutRoute = MR_ONEHOOK_OPERATIONS
    .filter((op) => !registered.has(`${op.method} ${op.path}`))
    .map((op) => `${op.operationId}: ${op.method} ${op.path}`);
  assert.deepEqual({ notInManifest, withoutRoute }, { notInManifest: [], withoutRoute: [] });
});

// ── (b) Outbound calls ────────────────────────────────────────────────────────

test('(b) every call to the OneHook backend goes through the generated client, and is an auth: iam operation', () => {
  const { calls, problems } = scanSdkCalls(productionSources());
  assert.deepEqual(problems, [], 'outbound HTTP that is not a generated-client call');
  const notIam: string[] = [];
  const found = new Set<string>();
  for (const call of calls) {
    const op = API_OPERATIONS.find((o) => o.operationId === call.operationId);
    if (!op) notIam.push(`${call.operationId} (${call.file}:${call.line}): not a OneHookService operation`);
    else if (op.auth !== 'iam') notIam.push(`${call.operationId} (${call.file}:${call.line}): auth: ${op.auth}`);
    else found.add(op.operationId);
  }
  assert.deepEqual(notIam, []);
  // The scan must still see the known calls; an empty result would pass the check above vacuously.
  for (const operationId of ['GetAiContextMatch', 'GetInternalMatchingStatus', 'RecordSuggestionInternal',
    'GetInternalMembership', 'ConfirmMrOneHookProHandover']) {
    assert.ok(found.has(operationId), `outbound call ${operationId} not found by the scan`);
  }
});

// The scans fail on what they cannot resolve, never skip it.
const scanOf = (text: string): SourceFile[] => [{ file: 'src/sample.ts', text }];

test('(a) scan: unresolvable route registrations are problems, not skipped', () => {
  const cases: Record<string, string> = {
    'path in a variable': "const router = Router();\nconst P = '/x';\nrouter.get(P, h);",
    'interpolated path': 'const app = express();\napp.post(`/api/${v}`, h);',
    'unnamed router': "app.use(Router().get('/x', h));",
    'prefix mount': "const app = express();\napp.use('/api', sub);",
    'router.route': "const router = Router();\nrouter.route('/x').get(h);",
    'unknown receiver': "makeRouter().thing.get('/x', h);",
  };
  for (const [name, text] of Object.entries(cases)) {
    const { problems } = scanRoutes(scanOf(text));
    assert.ok(problems.length > 0, name);
  }
  const { routes, problems } = scanRoutes(scanOf(
    "// router.get('/commented', h)\nconst router = Router();\nrouter.delete('/a/:id/b', h);\nconst s = \"router.get('/in-a-string')\";"));
  assert.deepEqual(problems, []);
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ['DELETE /a/{id}/b']);
});

test('(b) scan: hand-built HTTP is a problem; generated-client operations are read', () => {
  const cases: Record<string, string> = {
    'global fetch': "await fetch('https://x/state', { method: 'GET' });",
    'fetch field': 'class C { constructor(private readonly fetchImpl: typeof fetch = fetch) {} m() { return this.fetchImpl(u); } }',
    'fetch aliased': 'const f = fetch;\nawait f(u);',
    'other HTTP client': "import https from 'node:https';",
    'bare SDK client': "import { OneHookClient } from 'onehook-api-client';",
    'opaque send': 'class C { private readonly api: OneHook; m() { return this.api.send(cmd); } }',
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(scanSdkCalls(scanOf(text)).problems.length > 0, name);
  }
  const { calls, problems } = scanSdkCalls(scanOf(
    "import { GetUserStateCommand } from 'onehook-api-client';\nimport { ReceiveMessageCommand } from '@aws-sdk/client-sqs';\n"
      + 'class C { private readonly api: OneHook;\n constructor(f: typeof fetch = fetch) { this.api = createOneHookApiClient({ fetchImpl: f }); }\n'
      + ' m() { return this.api.getAiContextMatch({ matchId }); } n() { return new GetUserStateCommand({}); } }\n'
      + 'new ReceiveMessageCommand({});'));
  assert.deepEqual(problems, []);
  assert.deepEqual(calls.map((c) => c.operationId), ['GetAiContextMatch', 'GetUserState']);
  // The transport itself may call fetch.
  assert.deepEqual(scanSdkCalls([{ file: SDK_TRANSPORT_FILE, text: 'await fetchImpl(url, init);' }]).problems, []);
});

test('scan: the lexer keeps code and string contents apart', () => {
  const { skel } = lex("const a = 'x(y'; const r = /'(/g; const t = `${a}/p/${b('q')}`; // c(\n");
  assert.equal(skel.includes('x(y'), false);
  assert.equal(skel.includes('c('), false);
  assert.ok(skel.includes("${b(' ')}"), skel);
});

// ── OpenAPI copy ──────────────────────────────────────────────────────────────

const openapi = loadOpenApi();

test('(c) the vendored OpenAPI has exactly the manifest MrOneHookService operations, with the same auth', () => {
  const fromOpenApi = openApiOperations(openapi)
    .map((op) => `${op.operationId} ${op.method} ${op.path} ${Array.isArray(op.security) && op.security.length === 0 ? 'none' : 'cognito'}`)
    .sort();
  const fromManifest = MR_ONEHOOK_OPERATIONS.map((op) => `${op.operationId} ${op.method} ${op.path} ${op.auth}`).sort();
  assert.deepEqual(fromOpenApi, fromManifest, `stale ${VENDORED_OPENAPI_PATH}: run npm --prefix ../sdk run manifest:sync`);
});

test('(c) the vendored OpenAPI equals the sdk/ build (when it has been built)', (t) => {
  if (!siblingOpenApiPresent()) {
    t.skip(`no ${SIBLING_OPENAPI_PATH}; only the operation list is checked against the manifest`);
    return;
  }
  assert.equal(readFileSync(VENDORED_OPENAPI_PATH, 'utf8'), readFileSync(SIBLING_OPENAPI_PATH, 'utf8'),
    'the vendored MrOneHookService.openapi.json is stale: run npm --prefix ../sdk run manifest:sync');
});

// ── (c) Response bodies, per route ────────────────────────────────────────────

interface Observed {
  name: string;
  operationId: string;
  status: number;
  problems: string[];
}

const ISSUER = 'https://issuer.test';
const AUDIENCE = 'mr-onehook-test';
const NOW = '2026-11-05T00:00:00.000Z';

function session(sessionId: string, matchId?: string): ChatSession {
  return {
    sessionId,
    ...(matchId ? { matchId } : {}),
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: '2026-12-05T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'hello', createdAt: NOW, exchangeId: 'e1' },
      { role: 'assistant', content: 'hi there', createdAt: NOW, exchangeId: 'e1', mood: 'Happy' },
    ],
  };
}

/** Session store fake: per-member sessions; member `store-down` fails every read and write. */
function fakeSessionStore() {
  const bySubject = new Map<string, Map<string, ChatSession>>();
  const of = (subject: string) => {
    let sessions = bySubject.get(subject);
    if (!sessions) bySubject.set(subject, sessions = new Map());
    return sessions;
  };
  const failFor = (subject: string) => {
    if (subject === 'store-down') throw new Error('blob store unavailable');
  };
  return {
    seed: (subject: string, s: ChatSession) => { of(subject).set(s.sessionId, s); },
    store: {
      list: async (subject: string) => {
        failFor(subject);
        return [...of(subject).values()].map((s) => ({
          sessionId: s.sessionId, scope: s.matchId ? 'connection' as const : 'product' as const,
          createdAt: s.createdAt, updatedAt: s.updatedAt, expiresAt: s.expiresAt, messageCount: s.messages.length,
        }));
      },
      get: async (subject: string, sessionId: string) => { failFor(subject); return of(subject).get(sessionId); },
      delete: async (subject: string, sessionId: string) => {
        failFor(subject);
        if (sessionId === 'not-yours') throw new ChatSessionAccessError('not this member');
        of(subject).delete(sessionId);
      },
      appendExchange: async (input: { subject: string; matchId?: string; sessionId?: string; exchangeId: string; userMessage: string; assistantMessage: string; userAttachments?: StoredAttachmentRef[] }) => {
        const s = of(input.subject).get(input.sessionId ?? '') ?? { ...session(input.sessionId ?? input.exchangeId, input.matchId), messages: [] };
        s.messages.push(
          { role: 'user', content: input.userMessage, createdAt: NOW, exchangeId: input.exchangeId, ...(input.userAttachments ? { attachments: input.userAttachments } : {}) },
          { role: 'assistant', content: input.assistantMessage, createdAt: NOW, exchangeId: input.exchangeId },
        );
        of(input.subject).set(s.sessionId, s);
        return s;
      },
    },
  };
}

/** Model fake: the answer depends on the last message's text. */
const model = {
  chat: {
    completions: {
      create: async (params: { messages: Array<{ content: string }> }) => {
        const last = params.messages[params.messages.length - 1]?.content ?? '';
        const upstream = /^upstream-(\d{3})$/.exec(last);
        if (upstream) throw Object.assign(new Error('upstream'), { status: Number(upstream[1]) });
        if (last === 'model-broken') throw new Error('model broke');
        const answer = last === 'find someone'
          ? { reply: 'I will look.', mood: 'Excited', matchSuggestion: { prompt: 'someone outdoorsy', reasoning: 'You asked for someone outdoorsy' } }
          : last === 'need context'
            ? { reply: 'Tell me more.', mood: 'Thinking', needsMoreContext: true, contextRequest: { searchTerms: ['trip'], maxMessages: 3, dateRange: { from: '2026-10-01T00:00:00Z' } } }
            : { reply: 'Hello!', mood: 'Happy' };
        return { choices: [{ message: { content: JSON.stringify(answer) } }] };
      },
    },
  },
};

const matchContext = (matchId: string, messageHistoryAllowed: boolean) => ({
  matchId, status: 'active' as const, requestingUser: { displayName: 'Ada' }, matchedUser: { displayName: 'Grace' },
  profileAllowed: true, messageHistoryAllowed, policyVersion: 'v1',
});

const dataClient = {
  getAiVisibleMatch: async (_subject: string, matchId: string) => {
    if (matchId === 'm-gone') throw new MatchContextAccessError('gone');
    if (matchId === 'm-down') throw new MatchContextUnavailableError('down');
    return matchContext(matchId, matchId !== 'm-no-history');
  },
};

const chatQuota = {
  consume: async (subject: string) => {
    if (subject === 'quota-down') throw new QuotaUnavailableError('down');
    return subject === 'quota-spent' ? { allowed: false as const, remaining: 0 as const } : { allowed: true as const, remaining: 9 };
  },
  release: async () => {},
};

/** State as Mr OneHook Pro sees it: per-member snapshots; `state-down` cannot be read. */
const membership = {
  snapshots: new Map<string, MembershipSnapshot>(),
  confirmed: [] as string[],
  directory: {
    get: async (userId: string): Promise<MembershipSnapshot> => {
      if (userId === 'state-down') throw new MembershipUnavailableError('down');
      return membership.snapshots.get(userId) ?? { tier: SubscriptionTier.MUST };
    },
    confirmProHandover: async (_userId: string, activationId: string) => { membership.confirmed.push(activationId); },
  },
};

/** Reads files without any AI: image descriptions and transcripts are canned. */
const readers = {
  vision: { describe: async () => ({ text: 'A menu with prices. TEXT: Coffee 120', inputTokens: 900, outputTokens: 60 }) },
  transcriber: { transcribe: async () => ({ text: 'Hello from the voice note', seconds: 12 }) },
  documents: { read: async () => ({ text: 'Page one of the PDF', pages: 1 }) },
};

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

test('(c) every route answers bodies that match its declared responses in mr-onehook.smithy', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((ok) => jwks.listen(0, '127.0.0.1', ok));
  const env = (extra: Record<string, string>) => loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true', AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: AUDIENCE,
    AUTH_JWKS_URI: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`,
    CORS_ALLOWED_ORIGINS: 'https://app.test', ONEHOOK_DATA_API_URL: 'https://state.test', AZURE_STORAGE_ACCOUNT: 'acct',
    AZURE_SESSION_CONTAINER: 'sessions', ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1', CHAT_SESSION_STORAGE_ENABLED: 'true',
    CHAT_SESSION_PLAN_POLICIES: JSON.stringify({
      free: { enabled: true, maxSessions: 1, maxMessages: 50, retentionDays: 30 },
      pro: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 },
    }),
    MR_ONEHOOK_PRO_ENABLED: 'true', AZURE_PRO_TABLE: 'pro',
    MR_ONEHOOK_PRO_PAYMENT_PROVIDER: 'fake', ONEHOOK_STAGE: 'test',
    CHAT_ATTACHMENTS_ENABLED: 'true', ATTACHMENT_BURST_FILES: '3',
    ...extra,
  } as NodeJS.ProcessEnv);

  const fullConfig = env({});
  const sessions = fakeSessionStore();
  const readerSession = randomUUID();
  const goneSession = randomUUID();
  sessions.seed('reader', session(readerSession));
  sessions.seed('reader', session(goneSession, 'm-gone'));
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  const proTable = new MemoryProTable();
  const proStore = new ProStore(proTable);
  const pro = new ProSubscriptionService({
    store: proStore, provider: new FakeProPaymentProvider(), directory: membership.directory,
    prices: fullConfig.pro.prices, currency: 'INR', logger: quiet,
  });
  const container = new MemoryContainer();
  const attachmentStore = new AttachmentStore(container.asContainer());
  const processor = new AttachmentProcessor(readers, fullConfig.attachments.rates, 50);
  const usage = new AttachmentUsageLedger(proStore, fullConfig.attachments);
  const queue = new AttachmentProcessingQueue(attachmentStore, processor, usage, 2, quiet);
  const attachments = { store: attachmentStore, processor, usage, queue };
  const services = {
    client: model as never, deployment: 'test', dataClient: dataClient as never, chatQuota,
    suggestionRecorder: { record: async () => 'RECORDED' as const }, sessionStore: sessions.store as never,
    productContextProvider: async () => 'OneHook product context', pro, attachments,
  };
  const { pro: _noPro, attachments: _noAttachments, ...basicServices } = services;
  const publicChat = { client: model as never, deployment: 'test', productContextProvider: async () => 'OneHook product context' };
  const build = (config: ReturnType<typeof env>, withServices: Record<string, unknown> | false) => createApp({
    corsAllowedOrigins: [], contextualConfig: config, publicChat, ...(withServices ? { contextualServices: withServices as never } : {}),
  }).listen(0, '127.0.0.1');
  const servers = {
    full: build(fullConfig, services),
    noSessionStorage: build(env({ CHAT_SESSION_STORAGE_ENABLED: 'false' }), services),
    // Only Pro may save sessions: the Free plan's refusals.
    proOnlySessions: build(env({ CHAT_SESSION_PLAN_POLICIES: JSON.stringify({ pro: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 } }) }), services),
    proOff: build(env({ MR_ONEHOOK_PRO_ENABLED: 'false' }), services),
    proNoStore: build(fullConfig, basicServices),
    off: build(env({ CONTEXTUAL_AI_ENABLED: 'false' }), false),
    notConfigured: build(env({ ONEHOOK_DATA_API_URL: '' }), false),
  };
  await Promise.all(Object.values(servers).map((s) => new Promise<void>((ok) => (s.listening ? ok() : s.once('listening', ok)))));

  const token = (subject: string, tier: string) => new SignJWT({ 'custom:subscriptionTier': tier })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(subject)
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(privateKey);

  const observed: Observed[] = [];
  let ip = 0;
  const call = async (
    name: string,
    expectStatus: number,
    request: {
      method: string; path: string; app?: keyof typeof servers; as?: [string, string] | 'none' | 'bad';
      body?: unknown; rawBody?: string; bytes?: Uint8Array; headers?: Record<string, string>; ip?: string;
    },
  ): Promise<any> => {
    const server = servers[request.app ?? 'full'];
    const headers: Record<string, string> = { 'x-forwarded-for': request.ip ?? `10.0.0.${++ip}`, ...(request.headers ?? {}) };
    if (request.as === 'bad') headers.authorization = 'Bearer not-a-token';
    else if (request.as && request.as !== 'none') headers.authorization = `Bearer ${await token(...request.as)}`;
    if (request.body !== undefined || request.rawBody !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${request.path}`, {
      method: request.method,
      headers,
      ...(request.bytes ? { body: new Blob([new Uint8Array(request.bytes)]) } : request.rawBody !== undefined ? { body: request.rawBody } : request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    const raw = await response.text();
    const op = findOperation(openapi, request.method, request.path);
    const problems = op
      ? checkResponse(openapi, op, response.status, response.headers.get('content-type'), raw, response.headers)
      : [`${request.method} ${request.path} is not an operation`];
    if (response.status !== expectStatus) problems.push(`scenario expected ${expectStatus}, got ${response.status}: ${raw}`);
    observed.push({ name, operationId: op?.operationId ?? '?', status: response.status, problems });
    try { return JSON.parse(raw); } catch { return raw; }
  };

  const chat = '/api/member/product-connection-chat';
  const list = `${chat}/sessions`;
  const one = (id: string) => `${chat}/sessions/${id}`;
  const uploads = `${chat}/attachments`;
  const attachment = (id: string) => `${uploads}/${id}`;
  const proPath = '/api/member/mr-onehook-pro';
  const key = () => ({ 'idempotency-key': randomUUID() });
  const file = (name: string, type: string, extra: Record<string, string> = {}) => ({ 'content-type': type, 'x-attachment-name': encodeURIComponent(name), ...extra });
  const excerpt = { excerpts: [{ speaker: 'match', sentAt: NOW, text: 'see you Friday' }] };
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
  try {
    // UploadChatAttachment (before the chat scenarios that send files)
    const uploaded = await call('upload an image', 202, { method: 'POST', path: uploads, as: ['pro-chatter', 'INFINITY'], bytes: PNG, headers: file('menu.png', 'image/png') });
    assert.equal(uploaded.attachment.kind, 'image');
    const noteId = (await call('upload a text file', 202, { method: 'POST', path: uploads, as: ['pro-chatter', 'INFINITY'], bytes: Buffer.from('Packing list: tent, stove'), headers: file('list.txt', 'text/plain') })).attachment.attachmentId as string;
    await call('upload without a name', 400, { method: 'POST', path: uploads, as: ['pro-chatter', 'INFINITY'], bytes: PNG, headers: { 'content-type': 'image/png' } });
    await call('upload without a token', 401, { method: 'POST', path: uploads, as: 'none', bytes: PNG, headers: file('a.png', 'image/png') });
    await call('upload on the Free plan', 403, { method: 'POST', path: uploads, as: ['free-uploader', 'SUPER'], bytes: PNG, headers: file('a.png', 'image/png') });
    await call('upload a file the match sent, history not allowed', 403, { method: 'POST', path: uploads, as: ['pro-u2', 'INFINITY'], bytes: PNG, headers: file('a.png', 'image/png', { 'x-attachment-match-id': 'm-no-history', 'x-attachment-sender': 'match' }) });
    await call('upload for a match that is gone', 404, { method: 'POST', path: uploads, as: ['pro-u2', 'INFINITY'], bytes: PNG, headers: file('a.png', 'image/png', { 'x-attachment-match-id': 'm-gone', 'x-attachment-sender': 'self' }) });
    await call('upload, feature off', 404, { method: 'POST', path: uploads, app: 'off', as: ['pro-u2', 'INFINITY'], bytes: PNG, headers: file('a.png', 'image/png') });
    await call('upload an executable named .pdf', 415, { method: 'POST', path: uploads, as: ['pro-u2', 'INFINITY'], bytes: Buffer.from('4d5a90000300000004000000ffff0000', 'hex'), headers: file('cv.pdf', 'application/pdf') });
    await call('upload over 5 MiB', 413, { method: 'POST', path: uploads, as: ['pro-u2', 'INFINITY'], bytes: Buffer.alloc(5 * 1024 * 1024 + 1, 0x20), headers: file('big.txt', 'text/plain') });
    for (let i = 0; i < 2; i++) await call('upload within the burst', 202, { method: 'POST', path: uploads, as: ['pro-burst', 'INFINITY'], bytes: PNG, headers: file('a.png', 'image/png') });
    await call('upload within the burst', 202, { method: 'POST', path: uploads, as: ['pro-burst', 'INFINITY'], bytes: PNG, headers: file('a.png', 'image/png') });
    const overused = await call('upload over the burst limit', 429, { method: 'POST', path: uploads, as: ['pro-burst', 'INFINITY'], bytes: PNG, headers: file('a.png', 'image/png') });
    assert.equal(overused.error, 'ATTACHMENT_PROCESSING_UNAVAILABLE');
    assert.ok(Date.parse(overused.retryAt) > Date.now());
    await call('upload, not configured', 503, { method: 'POST', path: uploads, app: 'proNoStore', as: ['pro-u3', 'INFINITY'], bytes: PNG, headers: file('a.png', 'image/png') });
    await queue.idle();

    // GetChatAttachment
    const ready = await call('attachment status', 200, { method: 'GET', path: attachment(uploaded.attachment.attachmentId), as: ['pro-chatter', 'INFINITY'] });
    assert.equal(ready.attachment.status, 'READY');
    await call('attachment status without a token', 401, { method: 'GET', path: attachment(noteId), as: 'bad' });
    await call('attachment status of another member', 404, { method: 'GET', path: attachment(noteId), as: ['someone-else', 'INFINITY'] });
    await call('attachment status, not configured', 503, { method: 'GET', path: attachment(noteId), app: 'proNoStore', as: ['pro-chatter', 'INFINITY'] });
    for (let i = 0; i < 60; i++) await call('attachment polling (allowed)', 404, { method: 'GET', path: attachment(randomUUID()), as: ['poller', 'INFINITY'] });
    await call('attachment polling limit', 429, { method: 'GET', path: attachment(randomUUID()), as: ['poller', 'INFINITY'] });

    // GetChatAttachmentContent
    await call('attachment content', 200, { method: 'GET', path: `${attachment(noteId)}/content`, as: ['pro-chatter', 'INFINITY'] });
    await call('attachment content without a token', 401, { method: 'GET', path: `${attachment(noteId)}/content`, as: 'none' });
    await call('attachment content, unknown', 404, { method: 'GET', path: `${attachment(randomUUID())}/content`, as: ['pro-chatter', 'INFINITY'] });
    await call('attachment content, not configured', 503, { method: 'GET', path: `${attachment(noteId)}/content`, app: 'proNoStore', as: ['pro-chatter', 'INFINITY'] });
    for (let i = 0; i < 20; i++) await call('attachment content rate limit (allowed)', 404, { method: 'GET', path: `${attachment(randomUUID())}/content`, as: ['downloader', 'INFINITY'] });
    await call('attachment content rate limit', 429, { method: 'GET', path: `${attachment(randomUUID())}/content`, as: ['downloader', 'INFINITY'] });

    // ProductConnectionChat
    await call('product chat', 200, { method: 'POST', path: chat, as: ['p1', 'SUPER'], body: { message: 'hello' } });
    await call('free tier + suggestion', 200, { method: 'POST', path: chat, as: ['p2', 'MUST'], body: { message: 'find someone' } });
    await call('connection chat asking for context', 200, { method: 'POST', path: chat, as: ['p3', 'SUPER'], body: { message: 'need context', matchId: 'm-ok' } });
    await call('connection chat with excerpts', 200, { method: 'POST', path: chat, as: ['p3', 'SUPER'], body: { message: 'hello', matchId: 'm-ok', ephemeralMessageContext: excerpt } });
    await call('saved session', 200, { method: 'POST', path: chat, as: ['p4', 'SUPER'], body: { message: 'hello', sessionOptions: { persist: true } } });
    const withFiles = await call('saved session with files', 200, { method: 'POST', path: chat, as: ['pro-chatter', 'INFINITY'], body: { message: 'what is on the menu?', sessionOptions: { persist: true }, attachmentIds: [uploaded.attachment.attachmentId, noteId] } });
    assert.equal(withFiles.contextUsed.attachmentCount, 2);
    assert.equal(withFiles.plan, 'PRO');
    await call('invalid body', 400, { method: 'POST', path: chat, as: ['p5', 'SUPER'], body: { message: 42 } });
    await call('malformed JSON', 400, { method: 'POST', path: chat, as: ['p5', 'SUPER'], rawBody: '{"message":' });
    await call('file already sent', 400, { method: 'POST', path: chat, as: ['pro-chatter', 'INFINITY'], body: { message: 'again', attachmentIds: [noteId] } });
    await call('no token', 401, { method: 'POST', path: chat, as: 'none', body: { message: 'hello' } });
    await call('bad token', 401, { method: 'POST', path: chat, as: 'bad', body: { message: 'hello' } });
    await call('daily limit', 402, { method: 'POST', path: chat, as: ['quota-spent', 'MUST'], body: { message: 'hello' } });
    await call('session not in plan', 403, { method: 'POST', path: chat, app: 'proOnlySessions', as: ['p6', 'MUST'], body: { message: 'hello', sessionOptions: { persist: true } } });
    await call('files on the Free plan', 403, { method: 'POST', path: chat, as: ['p6', 'SUPER'], body: { message: 'hello', attachmentIds: [randomUUID()] } });
    await call('history not allowed', 403, { method: 'POST', path: chat, as: ['p6', 'SUPER'], body: { message: 'hello', matchId: 'm-no-history', ephemeralMessageContext: excerpt } });
    await call('match not available', 404, { method: 'POST', path: chat, as: ['p7', 'SUPER'], body: { message: 'hello', matchId: 'm-gone' } });
    await call('unknown session', 404, { method: 'POST', path: chat, as: ['p7', 'SUPER'], body: { message: 'hello', sessionOptions: { sessionId: randomUUID() } } });
    await call('unknown attachment', 404, { method: 'POST', path: chat, as: ['p7', 'INFINITY'], body: { message: 'hello', attachmentIds: [randomUUID()] } });
    await call('feature off', 404, { method: 'POST', path: chat, app: 'off', as: ['p7', 'SUPER'], body: { message: 'hello' } });
    const busyId = randomUUID();
    await attachmentStore.create('pro-busy', {
      schemaVersion: 1, attachmentId: busyId, userRef: stableReference('pro-busy'), name: 'clip.mp3', kind: 'audio', mediaType: 'audio/mpeg',
      reader: 'transcription', extension: 'mp3', sizeBytes: 3, source: 'upload', status: 'PROCESSING', place: 'pending',
      createdAt: NOW, updatedAt: NOW, expiresAt: future, usage: { month: '2026-11', reservedMilli: 0, settled: true, budgetMinor: 40_000 },
      leaseUntil: future,
    }, Buffer.from([1, 2, 3]));
    await call('attachment still processing', 409, { method: 'POST', path: chat, as: ['pro-busy', 'INFINITY'], body: { message: 'hello', attachmentIds: [busyId] } });
    await call('model rate limit', 429, { method: 'POST', path: chat, as: ['p8', 'SUPER'], body: { message: 'upstream-429' } });
    await call('not configured', 503, { method: 'POST', path: chat, app: 'notConfigured', as: ['p8', 'SUPER'], body: { message: 'hello' } });
    await call('no session storage', 503, { method: 'POST', path: chat, app: 'noSessionStorage', as: ['p8', 'SUPER'], body: { message: 'hello', sessionOptions: { persist: true } } });
    await call('quota store down', 503, { method: 'POST', path: chat, as: ['quota-down', 'MUST'], body: { message: 'hello' } });
    await call('match context down', 503, { method: 'POST', path: chat, as: ['p9', 'SUPER'], body: { message: 'hello', matchId: 'm-down' } });
    await call('model failure', 503, { method: 'POST', path: chat, as: ['p9', 'SUPER'], body: { message: 'model-broken' } });
    for (let i = 0; i < 20; i++) await call('member rate limit (allowed)', 200, { method: 'POST', path: chat, as: ['chatty', 'SUPER'], body: { message: 'hello' } });
    await call('member rate limit', 429, { method: 'POST', path: chat, as: ['chatty', 'SUPER'], body: { message: 'hello' } });

    // ListChatSessions
    await call('list', 200, { method: 'GET', path: list, as: ['reader', 'SUPER'] });
    await call('list without token', 401, { method: 'GET', path: list, as: 'none' });
    await call('list, feature off', 404, { method: 'GET', path: list, app: 'off', as: ['reader', 'SUPER'] });
    await call('list, store down', 503, { method: 'GET', path: list, as: ['store-down', 'SUPER'] });
    await call('list, not configured', 503, { method: 'GET', path: list, app: 'notConfigured', as: ['reader', 'SUPER'] });
    for (let i = 0; i < 20; i++) await call('list rate limit (allowed)', 200, { method: 'GET', path: list, as: ['lister', 'SUPER'] });
    await call('list rate limit', 429, { method: 'GET', path: list, as: ['lister', 'SUPER'] });

    // GetChatSession
    const saved = await call('get a session with files', 200, { method: 'GET', path: one(withFiles.session.sessionId), as: ['pro-chatter', 'INFINITY'] });
    assert.deepEqual(saved.session.messages[0].attachments.map((a: { name: string }) => a.name), ['menu.png', 'list.txt']);
    await call('get', 200, { method: 'GET', path: one(readerSession), as: ['reader', 'SUPER'] });
    await call('get without token', 401, { method: 'GET', path: one(readerSession), as: 'bad' });
    await call('get, plan without sessions', 403, { method: 'GET', path: one(readerSession), app: 'proOnlySessions', as: ['reader', 'MUST'] });
    await call('get unknown', 404, { method: 'GET', path: one(randomUUID()), as: ['reader', 'SUPER'] });
    await call('get, match gone', 404, { method: 'GET', path: one(goneSession), as: ['reader', 'SUPER'] });
    await call('get, feature off', 404, { method: 'GET', path: one(readerSession), app: 'off', as: ['reader', 'SUPER'] });
    await call('get, store down', 503, { method: 'GET', path: one(readerSession), as: ['store-down', 'SUPER'] });
    await call('get, no session storage', 503, { method: 'GET', path: one(readerSession), app: 'noSessionStorage', as: ['reader', 'SUPER'] });
    for (let i = 0; i < 20; i++) await call('get rate limit (allowed)', 404, { method: 'GET', path: one(randomUUID()), as: ['getter', 'SUPER'] });
    await call('get rate limit', 429, { method: 'GET', path: one(randomUUID()), as: ['getter', 'SUPER'] });

    // DeleteChatSession
    await call('delete', 204, { method: 'DELETE', path: one(randomUUID()), as: ['deleter', 'SUPER'] });
    await call('delete without token', 401, { method: 'DELETE', path: one(randomUUID()), as: 'none' });
    await call('delete, not yours', 404, { method: 'DELETE', path: one('not-yours'), as: ['deleter', 'SUPER'] });
    await call('delete, feature off', 404, { method: 'DELETE', path: one(randomUUID()), app: 'off', as: ['deleter', 'SUPER'] });
    await call('delete, store down', 503, { method: 'DELETE', path: one(randomUUID()), as: ['store-down', 'SUPER'] });
    for (let i = 0; i < 20; i++) await call('delete rate limit (allowed)', 204, { method: 'DELETE', path: one(randomUUID()), as: ['remover', 'SUPER'] });
    await call('delete rate limit', 429, { method: 'DELETE', path: one(randomUUID()), as: ['remover', 'SUPER'] });

    // GetMrOneHookPro
    const freeView = await call('Pro status, Free plan', 200, { method: 'GET', path: proPath, as: ['pro-viewer', 'SUPER'] });
    assert.deepEqual([freeView.plan, freeView.canPurchase, freeView.limits.dailyMessages, freeView.limits.maxSessions], ['FREE', true, 10, 1]);
    const memberView = await call('Pro status, included in the membership', 200, { method: 'GET', path: proPath, as: ['pro-viewer-2', 'INFINITY'] });
    assert.deepEqual([memberView.plan, memberView.source, memberView.canPurchase], ['PRO', 'MEMBERSHIP', false]);
    await call('Pro status without a token', 401, { method: 'GET', path: proPath, as: 'none' });
    await call('Pro status, Pro off', 404, { method: 'GET', path: proPath, app: 'proOff', as: ['pro-viewer', 'SUPER'] });
    await call('Pro status, not configured', 503, { method: 'GET', path: proPath, app: 'proNoStore', as: ['pro-viewer', 'SUPER'] });
    for (let i = 0; i < 20; i++) await call('Pro status rate limit (allowed)', 200, { method: 'GET', path: proPath, as: ['pro-watcher', 'SUPER'] });
    await call('Pro status rate limit', 429, { method: 'GET', path: proPath, as: ['pro-watcher', 'SUPER'] });

    // PurchaseMrOneHookPro
    const bought = await call('buy Pro', 200, { method: 'POST', path: `${proPath}/subscription`, as: ['buyer', 'SUPER'], headers: key(), body: { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' } });
    assert.deepEqual([bought.plan, bought.source, bought.subscription.status], ['PRO', 'SUBSCRIPTION', 'ACTIVE']);
    await call('buy Pro without a key', 400, { method: 'POST', path: `${proPath}/subscription`, as: ['buyer-2', 'SUPER'], body: { billingPeriod: 'MONTHLY' } });
    await call('buy Pro without a token', 401, { method: 'POST', path: `${proPath}/subscription`, as: 'none', headers: key(), body: { billingPeriod: 'MONTHLY' } });
    await call('buy Pro, declined', 402, { method: 'POST', path: `${proPath}/subscription`, as: ['buyer-2', 'SUPER'], headers: key(), body: { billingPeriod: 'MONTHLY', paymentToken: 'fake-decline' } });
    await call('buy Pro, Pro off', 404, { method: 'POST', path: `${proPath}/subscription`, app: 'proOff', as: ['buyer-2', 'SUPER'], headers: key(), body: { billingPeriod: 'MONTHLY' } });
    const included = await call('buy Pro, included in the membership', 409, { method: 'POST', path: `${proPath}/subscription`, as: ['inf-buyer', 'INFINITY'], headers: key(), body: { billingPeriod: 'YEARLY' } });
    assert.equal(included.error, 'PRO_INCLUDED_IN_MEMBERSHIP');
    await call('buy Pro, provider down', 503, { method: 'POST', path: `${proPath}/subscription`, as: ['buyer-3', 'SUPER'], headers: key(), body: { billingPeriod: 'MONTHLY', paymentToken: 'fake-error' } });
    for (let i = 0; i < 20; i++) await call('buy rate limit (allowed)', 400, { method: 'POST', path: `${proPath}/subscription`, as: ['buyer-spam', 'SUPER'], body: {} });
    await call('buy rate limit', 429, { method: 'POST', path: `${proPath}/subscription`, as: ['buyer-spam', 'SUPER'], body: {} });

    // UpdateMrOneHookProAutoRenew
    const stopped = await call('turn auto-renew off', 200, { method: 'PUT', path: `${proPath}/subscription/auto-renew`, as: ['buyer', 'SUPER'], body: { autoRenew: false } });
    assert.equal(stopped.subscription.autoRenew, false);
    await call('auto-renew, bad body', 400, { method: 'PUT', path: `${proPath}/subscription/auto-renew`, as: ['buyer', 'SUPER'], body: { autoRenew: 'no' } });
    await call('auto-renew without a token', 401, { method: 'PUT', path: `${proPath}/subscription/auto-renew`, as: 'bad', body: { autoRenew: true } });
    await call('auto-renew without a subscription', 404, { method: 'PUT', path: `${proPath}/subscription/auto-renew`, as: ['nobody', 'SUPER'], body: { autoRenew: true } });
    await pro.purchase('paused', SubscriptionTier.SUPER, { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' }, randomUUID());
    await pro.handleHandover('paused', 'activation-1', 'event-1');
    await call('auto-renew while the membership covers Pro', 409, { method: 'PUT', path: `${proPath}/subscription/auto-renew`, as: ['paused', 'INFINITY'], body: { autoRenew: true } });
    await call('auto-renew, not configured', 503, { method: 'PUT', path: `${proPath}/subscription/auto-renew`, app: 'proNoStore', as: ['buyer', 'SUPER'], body: { autoRenew: true } });
    for (let i = 0; i < 20; i++) await call('auto-renew rate limit (allowed)', 400, { method: 'PUT', path: `${proPath}/subscription/auto-renew`, as: ['renew-spam', 'SUPER'], body: {} });
    await call('auto-renew rate limit', 429, { method: 'PUT', path: `${proPath}/subscription/auto-renew`, as: ['renew-spam', 'SUPER'], body: {} });

    // ContinueMrOneHookProAfterMembership
    membership.snapshots.set('leaving', { tier: SubscriptionTier.INFINITY, endsAt: future });
    membership.snapshots.set('staying', { tier: SubscriptionTier.INFINITY });
    const kept = await call('keep Pro after the membership', 200, { method: 'PUT', path: `${proPath}/continuation`, as: ['leaving', 'INFINITY'], headers: key(), body: { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' } });
    assert.deepEqual([kept.subscription.status, kept.subscription.scheduledStartAt], ['SCHEDULED', future]);
    await call('keep Pro without a key', 400, { method: 'PUT', path: `${proPath}/continuation`, as: ['leaving', 'INFINITY'], body: { billingPeriod: 'MONTHLY' } });
    await call('keep Pro without a token', 401, { method: 'PUT', path: `${proPath}/continuation`, as: 'none', headers: key(), body: { billingPeriod: 'MONTHLY' } });
    await call('keep Pro, Pro off', 404, { method: 'PUT', path: `${proPath}/continuation`, app: 'proOff', as: ['leaving', 'INFINITY'], headers: key(), body: { billingPeriod: 'MONTHLY' } });
    await call('keep Pro, membership not ending', 409, { method: 'PUT', path: `${proPath}/continuation`, as: ['staying', 'INFINITY'], headers: key(), body: { billingPeriod: 'MONTHLY' } });
    await call('keep Pro, State unreachable', 503, { method: 'PUT', path: `${proPath}/continuation`, as: ['state-down', 'INFINITY'], headers: key(), body: { billingPeriod: 'MONTHLY' } });
    for (let i = 0; i < 20; i++) await call('keep Pro rate limit (allowed)', 400, { method: 'PUT', path: `${proPath}/continuation`, as: ['keep-spam', 'INFINITY'], body: {} });
    await call('keep Pro rate limit', 429, { method: 'PUT', path: `${proPath}/continuation`, as: ['keep-spam', 'INFINITY'], body: {} });

    // CancelMrOneHookProContinuation
    await call('withdraw keep Pro', 204, { method: 'DELETE', path: `${proPath}/continuation`, as: ['leaving', 'INFINITY'] });
    await call('withdraw keep Pro without a token', 401, { method: 'DELETE', path: `${proPath}/continuation`, as: 'none' });
    await call('withdraw keep Pro, Pro off', 404, { method: 'DELETE', path: `${proPath}/continuation`, app: 'proOff', as: ['leaving', 'INFINITY'] });
    await proStore.insert('started', CONTINUATION_ROW, {
      schemaVersion: 1, continuationId: randomUUID(), userId: 'started', status: 'STARTED', billingPeriod: 'MONTHLY',
      startsAt: NOW, idempotencyKey: randomUUID(), createdAt: NOW, updatedAt: NOW,
    });
    await call('withdraw keep Pro after it started', 409, { method: 'DELETE', path: `${proPath}/continuation`, as: ['started', 'SUPER'] });
    await call('withdraw keep Pro, not configured', 503, { method: 'DELETE', path: `${proPath}/continuation`, app: 'proNoStore', as: ['leaving', 'INFINITY'] });
    for (let i = 0; i < 20; i++) await call('withdraw rate limit (allowed)', 204, { method: 'DELETE', path: `${proPath}/continuation`, as: ['withdraw-spam', 'SUPER'] });
    await call('withdraw rate limit', 429, { method: 'DELETE', path: `${proPath}/continuation`, as: ['withdraw-spam', 'SUPER'] });

    // DismissMrOneHookProNotice
    const noticeId = (bought.notices as Array<{ noticeId: string; kind: string }>).find((n) => n.kind === 'PRO_PURCHASED')!.noticeId;
    await call('dismiss a notice', 204, { method: 'DELETE', path: `${proPath}/notices/${noticeId}`, as: ['buyer', 'SUPER'] });
    await call('dismiss without a token', 401, { method: 'DELETE', path: `${proPath}/notices/${noticeId}`, as: 'bad' });
    await call('dismiss, Pro off', 404, { method: 'DELETE', path: `${proPath}/notices/${noticeId}`, app: 'proOff', as: ['buyer', 'SUPER'] });
    await call('dismiss, not configured', 503, { method: 'DELETE', path: `${proPath}/notices/${noticeId}`, app: 'proNoStore', as: ['buyer', 'SUPER'] });
    for (let i = 0; i < 20; i++) await call('dismiss rate limit (allowed)', 204, { method: 'DELETE', path: `${proPath}/notices/x${i}`, as: ['dismiss-spam', 'SUPER'] });
    await call('dismiss rate limit', 429, { method: 'DELETE', path: `${proPath}/notices/x`, as: ['dismiss-spam', 'SUPER'] });

    // PublicProductChat
    const publicChatPath = '/api/public/product-chat';
    const visitor = { messages: [{ role: 'user', content: 'what is OneHook?' }] };
    await call('public chat', 200, { method: 'POST', path: publicChatPath, body: visitor });
    await call('public chat, no messages', 400, { method: 'POST', path: publicChatPath, body: {} });
    await call('public chat, attachments refused', 400, { method: 'POST', path: publicChatPath, body: { ...visitor, attachmentIds: [randomUUID()] } });
    await call('public chat, image content part refused', 400, { method: 'POST', path: publicChatPath, body: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] } });
    await call('public chat, model refused', 400, { method: 'POST', path: publicChatPath, body: { messages: [{ role: 'user', content: 'upstream-400' }] } });
    await call('public chat, honeypot', 403, { method: 'POST', path: publicChatPath, body: { ...visitor, honeypot: 'x' } });
    await call('public chat, model rate limit', 429, { method: 'POST', path: publicChatPath, body: { messages: [{ role: 'user', content: 'upstream-429' }] } });
    await call('public chat, model failure', 500, { method: 'POST', path: publicChatPath, body: { messages: [{ role: 'user', content: 'model-broken' }] } });
    await call('public chat, model unavailable', 503, { method: 'POST', path: publicChatPath, body: { messages: [{ role: 'user', content: 'upstream-503' }] } });
    for (let i = 0; i < 10; i++) await call('public rate limit (allowed)', 200, { method: 'POST', path: publicChatPath, body: visitor, ip: '10.9.9.9' });
    await call('public rate limit', 429, { method: 'POST', path: publicChatPath, body: visitor, ip: '10.9.9.9' });

    await call('public chat, model auth failure', 503, { method: 'POST', path: publicChatPath, body: { messages: [{ role: 'user', content: 'upstream-401' }] } });
    await call('public chat, body over 32 KB', 413, { method: 'POST', path: publicChatPath, body: { messages: [{ role: 'user', content: 'x'.repeat(40_000) }] } });

    // GetHealth
    await call('health', 200, { method: 'GET', path: '/health' });
  } finally {
    for (const s of Object.values(servers)) s.close();
    jwks.close();
  }

  const mismatches = observed.filter((o) => o.problems.length > 0).map((o) => `${o.operationId} / ${o.name}: ${o.problems.join('; ')}`);
  assert.deepEqual(mismatches, [], 'responses that do not match mr-onehook.smithy');

  // Every declared response of every operation was produced at least once. Service-level errors
  // (MrOneHookService `errors`: 413 and 500, answered by the shared Express handlers) are declared on
  // every operation; each must be declared everywhere and produced by at least one route.
  const SERVICE_LEVEL = ['413', '500'];
  const notExercised: string[] = [];
  for (const op of openApiOperations(openapi)) {
    for (const status of SERVICE_LEVEL) {
      if (!(status in op.responses)) notExercised.push(`${op.operationId} does not declare service-level ${status}`);
    }
    for (const status of Object.keys(op.responses)) {
      if (SERVICE_LEVEL.includes(status)) continue;
      if (!observed.some((o) => o.operationId === op.operationId && String(o.status) === status)) notExercised.push(`${op.operationId} ${status}`);
    }
  }
  for (const status of SERVICE_LEVEL) {
    if (!observed.some((o) => String(o.status) === status)) notExercised.push(`service-level ${status} never produced`);
  }
  assert.deepEqual(notExercised, [], 'declared responses no scenario produced');
});
