import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextualSystemPrompt } from '../contextPrompt';
import type { AiVisibleMatchContext } from '../contextTypes';
import { OneHookDataClient, visibleProfilesForPair } from '../oneHookDataClient';

// Chat-only profiles (design §8.6): State sends matching fields (bio, interests, relationshipGoals, ...) only
// when BOTH members' matching profiles are ACTIVE; displayName is always there. Mr OneHook must not assume
// those fields exist, and applies the same both-or-neither rule again on receipt.

const signer = { sign: async (r: { headers: Record<string, string> }) => r.headers };

function clientReturning(requesting: unknown, matched: unknown) {
  const fetchImpl = (async () => new Response(JSON.stringify({
    matchId: 'match-1',
    status: 'active',
    requestingUser: { id: 'user-1', visibleProfile: requesting },
    matchedUser: { visibleProfile: matched },
    contextPolicy: { profileAllowed: true, messageHistoryAllowed: false, policyVersion: 'v2' },
  }), { status: 200 })) as unknown as typeof fetch;
  return OneHookDataClient.withSigner('https://state.example', signer, 1000, fetchImpl);
}

const full = (name: string) => ({
  displayName: name,
  pronouns: 'they/them',
  bio: `${name} bio`,
  interests: ['hiking'],
  communicationPreferences: ['voice notes'],
  relationshipGoals: ['long term'],
});

test('chat-only projections (displayName only, as State sends unless both are ACTIVE) parse without inventing fields', async () => {
  const match = await clientReturning({ displayName: 'Ada' }, { displayName: 'Grace' }).getAiVisibleMatch('user-1', 'match-1');
  assert.deepEqual(match.requestingUser, { displayName: 'Ada' });
  assert.deepEqual(match.matchedUser, { displayName: 'Grace' });
});

test('matching fields are kept when both participants carry them', async () => {
  const match = await clientReturning(full('Ada'), full('Grace')).getAiVisibleMatch('user-1', 'match-1');
  assert.deepEqual(match.requestingUser, full('Ada'));
  assert.deepEqual(match.matchedUser, full('Grace'));
});

test('a one-sided projection is reduced to display names for BOTH participants', async () => {
  const oneSided = await clientReturning(full('Ada'), { displayName: 'Grace' }).getAiVisibleMatch('user-1', 'match-1');
  assert.deepEqual(oneSided.requestingUser, { displayName: 'Ada' });
  assert.deepEqual(oneSided.matchedUser, { displayName: 'Grace' });

  const otherSide = await clientReturning({ displayName: 'Ada' }, { bio: 'Grace bio' }).getAiVisibleMatch('user-1', 'match-1');
  assert.deepEqual(otherSide.requestingUser, { displayName: 'Ada' });
  assert.deepEqual(otherSide.matchedUser, {}, 'no display name, nothing invented');
});

test('empty or missing projections stay empty', async () => {
  const match = await clientReturning(undefined, {}).getAiVisibleMatch('user-1', 'match-1');
  assert.deepEqual(match.requestingUser, {});
  assert.deepEqual(match.matchedUser, {});
  assert.deepEqual(visibleProfilesForPair({}, {}), { requestingUser: {}, matchedUser: {} });
});

function promptFor(match: AiVisibleMatchContext): { profile?: unknown } {
  const { prompt } = buildContextualSystemPrompt(match, {
    matchId: match.matchId, message: 'help', includeProfile: true, includeMessageHistory: false, persistSession: false,
  }, []);
  const data = /<CONTEXT_DATA>\n([\s\S]*?)\n<\/CONTEXT_DATA>/.exec(prompt)?.[1];
  assert.ok(data, 'context block present');
  return JSON.parse(data) as { profile?: unknown };
}

const matchContext = (requestingUser: object, matchedUser: object): AiVisibleMatchContext => ({
  matchId: 'match-1', status: 'active', requestingUser, matchedUser,
  profileAllowed: true, messageHistoryAllowed: false, policyVersion: 'v2',
});

test('prompt carries only the display names when matching fields are absent', () => {
  const context = promptFor(matchContext({ displayName: 'Ada' }, { displayName: 'Grace' }));
  assert.deepEqual(context.profile, { you: { displayName: 'Ada' }, yourMatch: { displayName: 'Grace' } });
});

test('prompt assembly re-applies the both-or-neither rule to any match context', () => {
  const context = promptFor(matchContext(full('Ada'), { displayName: 'Grace' }));
  assert.deepEqual(context.profile, { you: { displayName: 'Ada' }, yourMatch: { displayName: 'Grace' } });
  const both = promptFor(matchContext(full('Ada'), full('Grace')));
  assert.deepEqual(both.profile, { you: full('Ada'), yourMatch: full('Grace') });
});

test('prompt tells the model never to invent absent profile fields', () => {
  const { prompt } = buildContextualSystemPrompt(matchContext({ displayName: 'Ada' }, { displayName: 'Grace' }), {
    matchId: 'match-1', message: 'what do they like?', includeProfile: true, includeMessageHistory: false, persistSession: false,
  }, []);
  assert.match(prompt, /PROFILE may hold only display names/);
  assert.match(prompt, /never guess or invent a bio, interests/);
});
