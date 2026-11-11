import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContextualModelResponse, buildContextualSystemPrompt } from '../contextPrompt';
import { MatchingSuggestionClient, sanitizeMatchSuggestion, disabledSuggestionRecorder } from '../matchingSuggestionClient';
import { MatchingStatusClient, MatchingStatusUnavailableError, type MatchingStatusReader } from '../matchingStatusClient';

const matchingOn: MatchingStatusReader = { get: async () => ({ status: 'ON', generation: 1 }) };

const reply = (extra: Record<string, unknown>) =>
  JSON.stringify({ reply: 'Done, I will look for people like that.', mood: 'Happy', ...extra });

test('model matchSuggestion is parsed, cleaned and bounded', () => {
  const parsed = parseContextualModelResponse(reply({
    matchSuggestion: { prompt: '  Someone outdoorsy\nwho loves books  ', reasoning: 'You asked for an outdoorsy reader' },
  }));
  assert.deepEqual(parsed.matchSuggestion, {
    prompt: 'Someone outdoorsy who loves books',
    reasoning: 'You asked for an outdoorsy reader',
  });
  const long = sanitizeMatchSuggestion({ prompt: 'x'.repeat(2000), reasoning: 'y'.repeat(500) });
  assert.equal(long?.prompt.length, 1000);
  assert.equal(long?.reasoning.length, 280);
});

test('an unusable matchSuggestion is dropped without failing the reply', () => {
  for (const bad of [undefined, 'text', [], { prompt: 'hi', reasoning: 'r' }, { prompt: 'someone kind' }, { reasoning: 'r' }]) {
    const parsed = parseContextualModelResponse(reply({ matchSuggestion: bad }));
    assert.equal(parsed.matchSuggestion, undefined);
    assert.equal(parsed.reply, 'Done, I will look for people like that.');
  }
});

test('prompt instructs the model to emit matchSuggestion only on explicit requests, without sensitive traits', () => {
  const { prompt } = buildContextualSystemPrompt(undefined, {
    message: 'find me someone', includeProfile: true, includeMessageHistory: true, persistSession: false,
  }, []);
  assert.match(prompt, /"matchSuggestion": include ONLY when the member explicitly asks/);
  assert.match(prompt, /never physical traits, race, religion/);
});

test('client signs the call with the service identity, carries the member token as proof, and maps outcomes', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const signed: Array<{ method: string; url: URL; headers: Record<string, string>; body?: string }> = [];
  const signer = {
    sign: async (r: { method: string; url: URL; headers: Record<string, string>; body?: string }) => {
      signed.push(r as never);
      return { ...r.headers, authorization: 'AWS4-HMAC-SHA256 Credential=test' };
    },
  };
  const respond = (status: number, body: unknown = {}) => (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const base = 'https://abc.execute-api.ap-south-1.amazonaws.com/gamma';
  const suggestion = { prompt: 'someone kind', reasoning: 'why' };
  const member = (idToken: string) => ({ userId: 'member-1', idToken });

  const ok = new MatchingSuggestionClient(base, signer, 1000, matchingOn, respond(201));
  assert.equal(await ok.record(member('member-id-token'), suggestion), 'RECORDED');
  assert.equal(calls[0]!.url, `${base}/matching/internal/suggestions`, 'no member id in the path');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-onehook-member-token'], 'member-id-token');
  assert.equal((signed[0] as unknown as { headers: Record<string, string> }).headers['x-onehook-member-token'], 'member-id-token',
    'the member token is inside the SigV4-signed headers');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'AWS4-HMAC-SHA256 Credential=test');
  assert.equal(signed[0]!.method, 'POST');
  assert.equal(signed[0]!.body, calls[0]!.init.body, 'the signed payload is exactly the sent payload');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), suggestion);

  // OneHook errors are `{error: <human message>, code: <MACHINE_CODE>}`; the client branches on `code` only.
  assert.equal(await new MatchingSuggestionClient(base, signer, 1000, matchingOn,
    respond(403, { error: 'OneHook suggestions need Super or above', code: 'PREMIUM_REQUIRED' }))
    .record(member('m'), suggestion), 'PREMIUM_REQUIRED');
  assert.equal(await new MatchingSuggestionClient(base, signer, 1000, matchingOn,
    respond(403, { error: 'Matching is off for this member', code: 'MATCHING_OFF', traceId: 't-1', retryable: false }))
    .record(member('m'), suggestion), 'MATCHING_OFF', 'Matching itself may still refuse after a racing opt-out');
  assert.equal(await new MatchingSuggestionClient(base, signer, 1000, matchingOn,
    respond(403, { error: 'User is not authorized to access this resource', code: 'ACCESS_DENIED' }))
    .record(member('m'), suggestion), 'UNAVAILABLE', 'an IAM denial is not a tier problem');
  assert.equal(await new MatchingSuggestionClient(base, signer, 1000, matchingOn, respond(403, { error: 'PREMIUM_REQUIRED' }))
    .record(member('m'), suggestion), 'UNAVAILABLE', 'the retired `{error: <CODE>}` shape is not read as a code');
  assert.equal(await new MatchingSuggestionClient(base, signer, 1000, matchingOn, respond(503)).record(member('m'), suggestion), 'UNAVAILABLE');
  const failingSigner = { sign: async () => { throw new Error('no AWS credentials'); } };
  assert.equal(await new MatchingSuggestionClient(base, failingSigner, 1000, matchingOn, respond(201)).record(member('m'), suggestion), 'UNAVAILABLE');
  assert.equal(await disabledSuggestionRecorder.record(member('m'), suggestion), 'UNAVAILABLE');
  assert.equal(await ok.record(member(''), suggestion), 'UNAVAILABLE', 'no member token, nothing sent');
});

// ── Matching-status gate (chat-only profiles, design §8.6) ───────────────────

const stateBase = 'https://state.execute-api.ap-south-1.amazonaws.com/gamma';

/** A fetch that answers State's status route and Matching's suggestion route, recording every call. */
function routedFetch(stateResponse: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.startsWith(stateBase)) return stateResponse();
    return new Response('{}', { status: 201 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const passthroughSigner = { sign: async (r: { headers: Record<string, string> }) => ({ ...r.headers, authorization: 'AWS4-HMAC-SHA256 x' }) };
const statusBody = (status: string, userId = 'member-1') =>
  new Response(JSON.stringify({ userId, status, generation: 3 }), { status: 200 });

async function recordWith(stateResponse: () => Response | Promise<Response>) {
  const { calls, fetchImpl } = routedFetch(stateResponse);
  const statusClient = new MatchingStatusClient(stateBase, passthroughSigner, 1000, fetchImpl);
  const client = new MatchingSuggestionClient(
    'https://matching.execute-api.ap-south-1.amazonaws.com/gamma', passthroughSigner, 1000, statusClient, fetchImpl);
  const status = await client.record({ userId: 'member-1', idToken: 'token' }, { prompt: 'someone kind', reasoning: 'why' });
  return { status, calls, suggestionSent: calls.some((url) => url.endsWith('/matching/internal/suggestions')) };
}

test('status gate: ON records the suggestion after reading the member status from State', async () => {
  const result = await recordWith(() => statusBody('ON'));
  assert.equal(result.status, 'RECORDED');
  assert.equal(result.calls[0], `${stateBase}/state/internal/users/member-1/matching`, 'status is read first');
  assert.equal(result.suggestionSent, true);
});

test('status gate: OFF, ERASING and an unknown member (State reads OFF) record nothing', async () => {
  for (const mode of ['OFF', 'ERASING']) {
    const result = await recordWith(() => statusBody(mode));
    assert.equal(result.status, 'MATCHING_OFF', mode);
    assert.equal(result.suggestionSent, false, `${mode}: nothing sent to Matching`);
  }
});

test('status gate fails closed: a failed or odd status read records nothing', async () => {
  const failures: Array<[string, () => Response | Promise<Response>]> = [
    ['500', () => new Response('{}', { status: 500 })],
    ['403 IAM denial', () => new Response('{"error":"Forbidden","code":"ACCESS_DENIED"}', { status: 403 })],
    ['network error', () => { throw new TypeError('fetch failed'); }],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['unknown status', () => statusBody('MAYBE')],
    ['another member', () => statusBody('ON', 'someone-else')],
    ['no generation', () => new Response(JSON.stringify({ userId: 'member-1', status: 'ON' }), { status: 200 })],
  ];
  for (const [name, respond] of failures) {
    const result = await recordWith(respond);
    assert.equal(result.status, 'UNAVAILABLE', name);
    assert.equal(result.suggestionSent, false, `${name}: nothing sent to Matching`);
  }
  const failingSigner = { sign: async () => { throw new Error('no AWS credentials'); } };
  const statusClient = new MatchingStatusClient(stateBase, failingSigner, 1000, routedFetch(() => statusBody('ON')).fetchImpl);
  await assert.rejects(() => statusClient.get('member-1'), MatchingStatusUnavailableError);
});

test('status client signs a GET for the member path on the State API', async () => {
  const signed: Array<{ method: string; url: URL }> = [];
  const signer = { sign: async (r: { method: string; url: URL; headers: Record<string, string> }) => { signed.push(r); return r.headers; } };
  const client = new MatchingStatusClient(stateBase, signer, 1000, routedFetch(() => statusBody('ON', 'a/b')).fetchImpl);
  assert.deepEqual(await client.get('a/b'), { status: 'ON', generation: 3 });
  assert.equal(signed[0]!.method, 'GET');
  assert.equal(signed[0]!.url.pathname, '/gamma/state/internal/users/a%2Fb/matching', 'the member id is path-encoded');
});

test('SigV4 signer signs the POST body hash', async () => {
  const { SigV4RequestSigner } = await import('../sigv4Signer');
  const creds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' });
  const signer = new SigV4RequestSigner('ap-south-1', 'execute-api', creds);
  const url = new URL('https://abc.execute-api.ap-south-1.amazonaws.com/gamma/matching/internal/suggestions');
  const a = await signer.sign({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  const b = await signer.sign({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body: '{"a":2}' });
  assert.match(a.authorization ?? '', /^AWS4-HMAC-SHA256 /);
  assert.notEqual(a['x-amz-content-sha256'] ?? a.authorization, b['x-amz-content-sha256'] ?? b.authorization,
    'different bodies produce different signatures');
});

test('route: the suggestion is gated on the verified token subject, and MATCHING_OFF reaches the response', async () => {
  const http = await import('node:http');
  const express = (await import('express')).default;
  const { exportJWK, generateKeyPair, SignJWT } = await import('jose');
  const { createContextualRouter } = await import('../contextRoutes');
  const { loadContextualFeatureConfig } = await import('../contextConfig');

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((ok) => jwks.listen(0, ok));
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks.json`;
  const config = loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true', AUTH_ISSUER: 'https://issuer.test', AUTH_AUDIENCE: 'aud', AUTH_JWKS_URI: jwksUrl,
    CORS_ALLOWED_ORIGINS: 'https://x', ONEHOOK_DATA_API_URL: 'https://data', AZURE_STORAGE_ACCOUNT: 'acct',
    AZURE_SESSION_CONTAINER: 'c', ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1',
  } as NodeJS.ProcessEnv);
  const model = { chat: { completions: { create: async () => ({ choices: [{ message: { content: reply({
    matchSuggestion: { prompt: 'Someone outdoorsy', reasoning: 'You asked for someone outdoorsy' },
  }) } }] }) } } };
  const statusChecks: string[] = [];
  const statusReader: MatchingStatusReader = {
    get: async (userId) => { statusChecks.push(userId); return { status: 'OFF', generation: 2 }; },
  };
  let matchingCalls = 0;
  const fetchImpl = (async () => { matchingCalls += 1; return new Response('{}', { status: 201 }); }) as unknown as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use(createContextualRouter(config, {
    client: model as never, deployment: 'd', dataClient: {} as never, sessionStore: {} as never,
    productContextProvider: async () => '',
    suggestionRecorder: new MatchingSuggestionClient('https://matching', { sign: async (r) => r.headers }, 1000, statusReader, fetchImpl),
  }));
  const server = app.listen(0);
  try {
    const jwt = await new SignJWT({ 'custom:subscriptionTier': 'SUPER' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('member-sub-1')
      .setIssuer('https://issuer.test').setAudience('aud').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/member/product-connection-chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ message: 'find me someone outdoorsy' }),
    });
    const body = await response.json() as { matchSuggestion?: { status: string } };
    assert.equal(response.status, 200);
    assert.deepEqual(statusChecks, ['member-sub-1'], 'the status of the verified subject is checked');
    assert.equal(matchingCalls, 0, 'nothing recorded for a member with matching off');
    assert.equal(body.matchSuggestion?.status, 'MATCHING_OFF');
  } finally {
    server.close();
    jwks.close();
  }
});
