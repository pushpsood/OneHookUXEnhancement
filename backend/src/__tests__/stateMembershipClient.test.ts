import test from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionTier } from 'onehook-api-client';
import { StateMembershipClient } from '../stateMembershipClient';
import { MembershipUnavailableError } from '../membershipDirectory';

/** State's IAM-only membership operations through the generated client: signed, parsed, fail closed. */
function client(answer: (url: URL, init: RequestInit) => Response) {
  const seen: Array<{ method: string; url: URL; signed: boolean }> = [];
  const signer = {
    sign: async (r: { headers: Record<string, string> }) => ({ ...r.headers, authorization: 'AWS4-HMAC-SHA256 test' }),
  };
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const headers = init.headers as Record<string, string>;
    seen.push({ method: String(init.method), url, signed: headers.authorization === 'AWS4-HMAC-SHA256 test' });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { directory: new StateMembershipClient('https://state.test/prod', signer, 1000, fetchImpl), seen };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('membership: State epoch seconds become ISO; the request is signed and names the member', async () => {
  const { directory, seen } = client(() => json(200, {
    userId: 'u1', tier: 'INFINITY', endsAt: 1_800_000_000,
    lastEnded: { at: 1_700_000_000, reason: 'CHARGEBACK', tier: 'SUPER' },
    pendingHandover: { activationId: 'a-1', tier: 'INFINITY', requestedAt: 1_700_000_100 },
  }));
  const snapshot = await directory.get('u1');
  assert.deepEqual(snapshot, {
    tier: SubscriptionTier.INFINITY,
    endsAt: '2027-01-15T08:00:00.000Z',
    lastEnded: { at: '2023-11-14T22:13:20.000Z', reason: 'CHARGEBACK', tier: SubscriptionTier.SUPER },
  });
  assert.equal(seen[0]!.method, 'GET');
  assert.equal(seen[0]!.url.pathname, '/prod/state/internal/users/u1/membership');
  assert.ok(seen[0]!.signed);
});

test('membership: an unknown member reads as the lowest tier; a bad or failed answer is "unavailable", never "not a member"', async () => {
  assert.deepEqual(await client(() => json(200, { userId: 'u1', tier: 'MUST' })).directory.get('u1'), { tier: SubscriptionTier.MUST });
  for (const answer of [
    () => json(500, { error: 'boom' }),
    () => json(403, { error: 'IAM authorization required' }),
    () => json(200, { userId: 'someone-else', tier: 'INFINITY' }),
    () => json(200, { userId: 'u1', tier: 'INFINITY', lastEnded: { at: 1, reason: 'NOPE', tier: 'SUPER' } }),
  ]) {
    await assert.rejects(client(answer).directory.get('u1'), MembershipUnavailableError);
  }
  await assert.rejects(client(() => json(200, {})).directory.get(''), MembershipUnavailableError);
});

test('handover confirmation: POSTs the activation; any outcome is confirmed; a failure is retried', async () => {
  const { directory, seen } = client(() => json(200, { userId: 'u1', activationId: 'a-1', outcome: 'NOT_PENDING' }));
  await directory.confirmProHandover('u1', 'a-1');
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.url.pathname, '/prod/state/internal/users/u1/mr-onehook-pro-handovers/a-1/confirmation');
  assert.ok(seen[0]!.signed);
  await assert.rejects(client(() => json(404, { error: 'User not found' })).directory.confirmProHandover('u1', 'a-1'), MembershipUnavailableError);
  await assert.rejects(client(() => json(200, { activationId: 'other' })).directory.confirmProHandover('u1', 'a-1'), MembershipUnavailableError);
});
