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

test('client posts the suggestion with the member token and maps outcomes', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const respond = (status: number) => (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;

  const ok = new MatchingSuggestionClient('https://api.gamma.onehook.club', 1000, respond(201));
  assert.equal(await ok.record('member-token', { prompt: 'someone kind', reasoning: 'why' }), 'RECORDED');
  assert.equal(calls[0]!.url, 'https://api.gamma.onehook.club/matching/suggestions');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer member-token');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { prompt: 'someone kind', reasoning: 'why' });

  assert.equal(await new MatchingSuggestionClient('u', 1000, respond(403)).record('t', { prompt: 'abc', reasoning: 'r' }), 'PREMIUM_REQUIRED');
  assert.equal(await new MatchingSuggestionClient('u', 1000, respond(503)).record('t', { prompt: 'abc', reasoning: 'r' }), 'UNAVAILABLE');
  const throwing = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
  assert.equal(await new MatchingSuggestionClient('u', 1000, throwing).record('t', { prompt: 'abc', reasoning: 'r' }), 'UNAVAILABLE');
  assert.equal(await disabledSuggestionRecorder.record('t', { prompt: 'abc', reasoning: 'r' }), 'UNAVAILABLE');
});
