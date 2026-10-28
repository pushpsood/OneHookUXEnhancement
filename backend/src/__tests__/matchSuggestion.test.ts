import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContextualModelResponse, buildContextualSystemPrompt } from '../contextPrompt';
import { MatchingSuggestionClient, sanitizeMatchSuggestion, disabledSuggestionRecorder } from '../matchingSuggestionClient';

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

  const ok = new MatchingSuggestionClient(base, signer, 1000, respond(201));
  assert.equal(await ok.record('member-id-token', suggestion), 'RECORDED');
  assert.equal(calls[0]!.url, `${base}/matching/internal/suggestions`, 'no member id in the path');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-onehook-member-token'], 'member-id-token');
  assert.equal((signed[0] as unknown as { headers: Record<string, string> }).headers['x-onehook-member-token'], 'member-id-token',
    'the member token is inside the SigV4-signed headers');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'AWS4-HMAC-SHA256 Credential=test');
  assert.equal(signed[0]!.method, 'POST');
  assert.equal(signed[0]!.body, calls[0]!.init.body, 'the signed payload is exactly the sent payload');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), suggestion);

  assert.equal(await new MatchingSuggestionClient(base, signer, 1000, respond(403, { error: 'PREMIUM_REQUIRED' }))
    .record('m', suggestion), 'PREMIUM_REQUIRED');
  assert.equal(await new MatchingSuggestionClient(base, signer, 1000, respond(403, { message: 'not authorized' }))
    .record('m', suggestion), 'UNAVAILABLE', 'an IAM denial is not a tier problem');
  assert.equal(await new MatchingSuggestionClient(base, signer, 1000, respond(503)).record('m', suggestion), 'UNAVAILABLE');
  const failingSigner = { sign: async () => { throw new Error('no AWS credentials'); } };
  assert.equal(await new MatchingSuggestionClient(base, failingSigner, 1000, respond(201)).record('m', suggestion), 'UNAVAILABLE');
  assert.equal(await disabledSuggestionRecorder.record('m', suggestion), 'UNAVAILABLE');
  assert.equal(await ok.record('', suggestion), 'UNAVAILABLE', 'no member token, nothing sent');
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
