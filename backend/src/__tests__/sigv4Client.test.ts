import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MatchContextAccessError,
  MatchContextUnavailableError,
  OneHookDataClient,
  type RequestSigner,
} from '../oneHookDataClient';
import { SigV4RequestSigner } from '../sigv4Signer';

// Static, non-secret test credentials so SigV4 signing is deterministic and fully offline.
const testCredentials = async () => ({
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

test('SigV4RequestSigner produces AWS SigV4 headers and preserves the member id header', async () => {
  const signer = new SigV4RequestSigner('ap-south-1', 'execute-api', testCredentials);
  const url = new URL('https://api.gamma.onehook.club/api/ai-context/matches/match-1');

  const headers = await signer.sign({
    method: 'GET',
    url,
    headers: { 'x-onehook-user-id': 'user-1', accept: 'application/json' },
  });

  // Authorization must be a SigV4 credential for execute-api in the configured region.
  assert.match(headers.authorization ?? '', /^AWS4-HMAC-SHA256 /);
  assert.match(headers.authorization ?? '', /\/ap-south-1\/execute-api\/aws4_request/);
  // The amz date is present and the member-id + host are part of the request.
  assert.ok(headers['x-amz-date'], 'x-amz-date header must be set');
  assert.equal(headers['x-onehook-user-id'], 'user-1');
  // The member id is included in the SignedHeaders list, so it cannot be altered without resigning.
  assert.match(headers.authorization ?? '', /SignedHeaders=[^,]*x-onehook-user-id/);
});

test('OneHookDataClient.withSigner sends signed headers and parses the active-match contract', async () => {
  const signer = new SigV4RequestSigner('ap-south-1', 'execute-api', testCredentials);
  let sentHeaders: Record<string, string> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sentHeaders = init.headers as Record<string, string>;
    return new Response(JSON.stringify({
      matchId: 'match-1',
      status: 'active',
      requestingUser: { id: 'user-1', visibleProfile: { displayName: 'Ada', interests: ['logic'] } },
      matchedUser: { visibleProfile: { displayName: 'Grace' } },
      contextPolicy: { profileAllowed: true, messageHistoryAllowed: true, policyVersion: 'v1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const client = OneHookDataClient.withSigner('https://api.gamma.onehook.club', signer, 2000, fetchImpl);
  const result = await client.getAiVisibleMatch('user-1', 'match-1');

  assert.match(sentHeaders.authorization ?? '', /^AWS4-HMAC-SHA256 /);
  assert.equal(sentHeaders['x-onehook-user-id'], 'user-1');
  assert.equal(result.matchId, 'match-1');
  assert.equal(result.status, 'active');
  assert.deepEqual(result.requestingUser, { displayName: 'Ada', interests: ['logic'] });
  assert.deepEqual(result.matchedUser, { displayName: 'Grace' });
  assert.equal(result.profileAllowed, true);
  assert.equal(result.messageHistoryAllowed, true);
  assert.equal(result.policyVersion, 'v1');
});

test('404 from the AWS_IAM route maps to a match-access error, not an outage', async () => {
  const signer = new SigV4RequestSigner('ap-south-1', 'execute-api', testCredentials);
  const fetchImpl = (async () => new Response('{"error":"Match not found"}', {
    status: 404, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  const client = OneHookDataClient.withSigner('https://api.gamma.onehook.club', signer, 2000, fetchImpl);
  await assert.rejects(() => client.getAiVisibleMatch('user-1', 'match-1'), MatchContextAccessError);
});

test('a signer failure surfaces as unavailable, never as a missing match', async () => {
  const failingSigner: RequestSigner = {
    sign: async () => {
      throw new Error('no resolvable AWS credentials');
    },
  };
  const fetchImpl = (async () => {
    throw new Error('fetch must not be called when signing fails');
  }) as unknown as typeof fetch;
  const client = OneHookDataClient.withSigner('https://api.gamma.onehook.club', failingSigner, 2000, fetchImpl);
  await assert.rejects(() => client.getAiVisibleMatch('user-1', 'match-1'), MatchContextUnavailableError);
});
