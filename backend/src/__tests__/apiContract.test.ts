import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { API_OPERATIONS } from '../generated/apiManifest';
import { createApp } from '../app';
import { loadContextualFeatureConfig } from '../contextConfig';
import { QuotaUnavailableError } from '../chatQuota';
import { ChatSessionAccessError, type ChatSession } from '../plaintextChatSessionStore';
import { MatchContextAccessError, MatchContextUnavailableError } from '../oneHookDataClient';
import {
  lex,
  normalizeTemplate,
  productionSources,
  scanOutboundCalls,
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
 * API contract tests: this service against the Smithy-generated manifest (src/generated/apiManifest.ts)
 * and Mr OneHook's OpenAPI (mr-onehook.smithy, vendored copy in contract/).
 *  (a) every Express route it registers is a `MrOneHookService` operation, and every operation has a route;
 *  (b) every outbound call is a OneHook operation with `auth: iam` (and is SigV4-signed);
 *  (c) every route's success and error bodies match the operation's declared responses.
 */

const MR_ONEHOOK_OPERATIONS = API_OPERATIONS.filter((op) => op.service === 'mr-onehook');

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

test('(b) every outbound call is a manifest operation with auth: iam', () => {
  const { calls, problems } = scanOutboundCalls(productionSources());
  assert.deepEqual(problems, [], 'outbound call sites the scan cannot resolve');
  const notIam: string[] = [];
  const found = new Set<string>();
  for (const call of calls) {
    const op = API_OPERATIONS.find((o) => o.method === call.method && normalizeTemplate(o.path) === call.path);
    if (!op) notIam.push(`${call.method} ${call.rawPath} (${call.file}:${call.line}): not in the manifest`);
    else if (op.auth !== 'iam') notIam.push(`${call.method} ${call.rawPath} (${call.file}:${call.line}): ${op.operationId} is auth: ${op.auth}`);
    else found.add(op.operationId);
  }
  assert.deepEqual(notIam, []);
  // The scan must still see the known calls; an empty result would pass the check above vacuously.
  for (const operationId of ['GetAiContextMatch', 'GetInternalMatchingStatus', 'RecordSuggestionInternal']) {
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

test('(b) scan: unresolvable or unsigned outbound calls are problems, not skipped', () => {
  const signed = (url: string, extra = '') => `const url = new URL(${url});\nconst headers = await this.signer.sign({ method: 'GET', url, headers: {} });\n${extra}await this.fetchImpl(url.toString(), { method: 'GET', headers });`;
  const cases: Record<string, string> = {
    'URL not a const': 'await fetch(someUrl, { method: "GET" });',
    'URL from config': "const url = new URL(config.endpoint);\nawait fetch(url, { method: 'GET' });",
    'fetch aliased': 'const f = fetch;\nawait f(u);',
    'no method': "const url = new URL(`${this.baseUrl}/x`);\nawait fetch(url, {});",
    'unsigned': "const url = new URL(`${this.baseUrl}/x`);\nawait fetch(url, { method: 'GET' });",
    'signed with another method': signed('`${this.baseUrl}/x`').replace("method: 'GET', headers }", "method: 'POST', headers }"),
    'partial segment': signed('`${this.baseUrl}/x/u-${id}`'),
    'path mutated': signed('`${this.baseUrl}/x`', "url.pathname = '/y';\n"),
    'other HTTP client': "import https from 'node:https';",
  };
  for (const [name, text] of Object.entries(cases)) {
    const { problems } = scanOutboundCalls(scanOf(`class C { fetchImpl: typeof fetch = fetch; async m() {\n${text}\n} }`));
    assert.ok(problems.length > 0, name);
  }
  const { calls, problems } = scanOutboundCalls(scanOf(
    `class C { constructor(private readonly fetchImpl: typeof fetch = fetch) {} async m() {\n${signed('`${this.baseUrl}/state/internal/users/${encodeURIComponent(id)}/matching`')}\n} }`));
  assert.deepEqual(problems, []);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /state/internal/users/{}/matching']);
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
  assert.deepEqual(fromOpenApi, fromManifest, `stale ${VENDORED_OPENAPI_PATH}: refresh it from OneHookBackend`);
});

test('(c) the vendored OpenAPI equals the OneHookBackend build (when that checkout is present)', (t) => {
  if (!siblingOpenApiPresent()) {
    t.skip(`no ${SIBLING_OPENAPI_PATH}; only the operation list is checked against the manifest`);
    return;
  }
  assert.equal(readFileSync(VENDORED_OPENAPI_PATH, 'utf8'), readFileSync(SIBLING_OPENAPI_PATH, 'utf8'),
    'the vendored MrOneHookService.openapi.json is stale: copy it from the OneHookBackend build');
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
      { role: 'assistant', content: 'hi there', createdAt: NOW, exchangeId: 'e1' },
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
      appendExchange: async (input: { subject: string; matchId?: string; sessionId?: string; exchangeId: string; userMessage: string; assistantMessage: string }) => {
        const s = of(input.subject).get(input.sessionId ?? '') ?? session(input.sessionId ?? input.exchangeId, input.matchId);
        s.messages.push(
          { role: 'user', content: input.userMessage, createdAt: NOW, exchangeId: input.exchangeId },
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
    CHAT_SESSION_TIER_POLICIES: JSON.stringify({
      super: { enabled: true, maxSessions: 1, maxMessages: 50, retentionDays: 30 },
      infinity: { enabled: true, maxSessions: 1, maxMessages: 50, retentionDays: 30 },
    }),
    ...extra,
  } as NodeJS.ProcessEnv);

  const sessions = fakeSessionStore();
  const readerSession = randomUUID();
  const goneSession = randomUUID();
  sessions.seed('reader', session(readerSession));
  sessions.seed('reader', session(goneSession, 'm-gone'));
  sessions.seed('full', session(randomUUID()));
  const services = {
    client: model as never, deployment: 'test', dataClient: dataClient as never, chatQuota,
    suggestionRecorder: { record: async () => 'RECORDED' as const }, sessionStore: sessions.store as never,
    productContextProvider: async () => 'OneHook product context',
  };
  const publicChat = { client: model as never, deployment: 'test', productContextProvider: async () => 'OneHook product context' };
  const build = (config: ReturnType<typeof env>, withServices: boolean) => createApp({
    corsAllowedOrigins: [], contextualConfig: config, publicChat, ...(withServices ? { contextualServices: services } : {}),
  }).listen(0, '127.0.0.1');
  const servers = {
    full: build(env({}), true),
    noSessionStorage: build(env({ CHAT_SESSION_STORAGE_ENABLED: 'false' }), true),
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
    request: { method: string; path: string; app?: keyof typeof servers; as?: [string, string] | 'none' | 'bad'; body?: unknown; rawBody?: string; ip?: string },
  ) => {
    const server = servers[request.app ?? 'full'];
    const headers: Record<string, string> = { 'x-forwarded-for': request.ip ?? `10.0.0.${++ip}` };
    if (request.as === 'bad') headers.authorization = 'Bearer not-a-token';
    else if (request.as && request.as !== 'none') headers.authorization = `Bearer ${await token(...request.as)}`;
    if (request.body !== undefined || request.rawBody !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${request.path}`, {
      method: request.method,
      headers,
      ...(request.rawBody !== undefined ? { body: request.rawBody } : request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    const raw = await response.text();
    const op = findOperation(openapi, request.method, request.path);
    const problems = op
      ? checkResponse(openapi, op, response.status, response.headers.get('content-type'), raw)
      : [`${request.method} ${request.path} is not an operation`];
    if (response.status !== expectStatus) problems.push(`scenario expected ${expectStatus}, got ${response.status}: ${raw}`);
    observed.push({ name, operationId: op?.operationId ?? '?', status: response.status, problems });
  };

  const chat = '/api/member/product-connection-chat';
  const list = `${chat}/sessions`;
  const one = (id: string) => `${chat}/sessions/${id}`;
  const excerpt = { excerpts: [{ speaker: 'match', sentAt: NOW, text: 'see you Friday' }] };
  try {
    // ProductConnectionChat
    await call('product chat', 200, { method: 'POST', path: chat, as: ['p1', 'SUPER'], body: { message: 'hello' } });
    await call('free tier + suggestion', 200, { method: 'POST', path: chat, as: ['p2', 'MUST'], body: { message: 'find someone' } });
    await call('connection chat asking for context', 200, { method: 'POST', path: chat, as: ['p3', 'SUPER'], body: { message: 'need context', matchId: 'm-ok' } });
    await call('connection chat with excerpts', 200, { method: 'POST', path: chat, as: ['p3', 'SUPER'], body: { message: 'hello', matchId: 'm-ok', ephemeralMessageContext: excerpt } });
    await call('saved session', 200, { method: 'POST', path: chat, as: ['p4', 'SUPER'], body: { message: 'hello', sessionOptions: { persist: true } } });
    await call('invalid body', 400, { method: 'POST', path: chat, as: ['p5', 'SUPER'], body: { message: 42 } });
    await call('malformed JSON', 400, { method: 'POST', path: chat, as: ['p5', 'SUPER'], rawBody: '{"message":' });
    await call('no token', 401, { method: 'POST', path: chat, as: 'none', body: { message: 'hello' } });
    await call('bad token', 401, { method: 'POST', path: chat, as: 'bad', body: { message: 'hello' } });
    await call('daily limit', 402, { method: 'POST', path: chat, as: ['quota-spent', 'MUST'], body: { message: 'hello' } });
    await call('session not in tier', 403, { method: 'POST', path: chat, as: ['p6', 'MUST'], body: { message: 'hello', sessionOptions: { persist: true } } });
    await call('history not allowed', 403, { method: 'POST', path: chat, as: ['p6', 'SUPER'], body: { message: 'hello', matchId: 'm-no-history', ephemeralMessageContext: excerpt } });
    await call('match not available', 404, { method: 'POST', path: chat, as: ['p7', 'SUPER'], body: { message: 'hello', matchId: 'm-gone' } });
    await call('unknown session', 404, { method: 'POST', path: chat, as: ['p7', 'SUPER'], body: { message: 'hello', sessionOptions: { sessionId: randomUUID() } } });
    await call('feature off', 404, { method: 'POST', path: chat, app: 'off', as: ['p7', 'SUPER'], body: { message: 'hello' } });
    await call('session cap', 409, { method: 'POST', path: chat, as: ['full', 'SUPER'], body: { message: 'hello', sessionOptions: { persist: true } } });
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
    await call('get', 200, { method: 'GET', path: one(readerSession), as: ['reader', 'SUPER'] });
    await call('get without token', 401, { method: 'GET', path: one(readerSession), as: 'bad' });
    await call('get, tier without sessions', 403, { method: 'GET', path: one(readerSession), as: ['reader-must', 'MUST'] });
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

    // PublicProductChat
    const publicChatPath = '/api/public/product-chat';
    const visitor = { messages: [{ role: 'user', content: 'what is OneHook?' }] };
    await call('public chat', 200, { method: 'POST', path: publicChatPath, body: visitor });
    await call('public chat, no messages', 400, { method: 'POST', path: publicChatPath, body: {} });
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
