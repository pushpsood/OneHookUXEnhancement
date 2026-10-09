import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContainerClient } from '@azure/storage-blob';
import {
  ChatSessionAccessError,
  ChatSessionLimitError,
  PlaintextChatSessionStore,
  sessionScopeReference,
} from '../plaintextChatSessionStore';

class MemoryContainer {
  readonly blobs = new Map<string, Buffer>();
  readonly etags = new Map<string, string>();
  private nextEtag = 1;

  getBlockBlobClient(name: string) {
    return {
      exists: async () => this.blobs.has(name),
      downloadToBuffer: async () => Buffer.from(this.blobs.get(name)!),
      getProperties: async () => ({ etag: this.etags.get(name) }),
      deleteIfExists: async () => {
        const deleted = this.blobs.delete(name);
        this.etags.delete(name);
        return { succeeded: deleted };
      },
      uploadData: async (data: Buffer, options?: { conditions?: { ifMatch?: string; ifNoneMatch?: string } }) => {
        const currentEtag = this.etags.get(name);
        if (options?.conditions?.ifNoneMatch === '*' && this.blobs.has(name)) {
          throw Object.assign(new Error('Precondition failed'), { statusCode: 412 });
        }
        if (options?.conditions?.ifMatch && options.conditions.ifMatch !== currentEtag) {
          throw Object.assign(new Error('Precondition failed'), { statusCode: 412 });
        }
        this.blobs.set(name, Buffer.from(data));
        this.etags.set(name, `etag-${this.nextEtag++}`);
        return {};
      },
    };
  }

  async *listBlobsFlat(options: { prefix?: string }) {
    for (const name of [...this.blobs.keys()]) {
      if (!options.prefix || name.startsWith(options.prefix)) yield { name };
    }
  }
}

const policy = { maxSessions: 1, maxMessages: 2, retentionDays: 30 };
const firstSessionId = '11111111-1111-4111-8111-111111111111';
const secondSessionId = '22222222-2222-4222-8222-222222222222';

test('plaintext AI chat sessions enforce user, match, idempotency, and tier bounds', async () => {
  const container = new MemoryContainer();
  const store = new PlaintextChatSessionStore(container as unknown as ContainerClient);

  const first = await store.appendExchange({
    subject: 'cognito-user-1',
    matchId: 'match-1',
    sessionId: firstSessionId,
    exchangeId: 'exchange-1',
    userMessage: 'private user text',
    assistantMessage: 'private assistant text',
    policy,
  });
  assert.equal(first.messages.length, 2);
  assert.equal(container.blobs.size, 2, 'one plaintext AI session and one hashed quota ledger are stored');
  const sessionBlob = [...container.blobs.entries()].find(([name]) => name.startsWith('sessions/'))?.[1];
  assert.ok(sessionBlob);
  const raw = sessionBlob.toString('utf8');
  assert.equal(raw.includes('cognito-user-1'), false, 'raw Cognito subject remains pseudonymized');
  for (const expected of ['match-1', firstSessionId, 'private user text', 'private assistant text']) {
    assert.equal(raw.includes(expected), true, `AI session record should contain ${expected}`);
  }
  assert.equal(raw.includes('ciphertext'), false);
  assert.equal(raw.includes('wrappedKey'), false);
  assert.equal(await store.get('another-user', firstSessionId), undefined);

  const duplicate = await store.appendExchange({
    subject: 'cognito-user-1',
    matchId: 'match-1',
    sessionId: firstSessionId,
    exchangeId: 'exchange-1',
    userMessage: 'private user text',
    assistantMessage: 'private assistant text',
    policy,
  });
  assert.equal(duplicate.messages.length, 2, 'same exchange is not appended twice');

  const updated = await store.appendExchange({
    subject: 'cognito-user-1',
    matchId: 'match-1',
    sessionId: firstSessionId,
    exchangeId: 'exchange-2',
    userMessage: 'second user text',
    assistantMessage: 'second assistant text',
    policy,
  });
  assert.deepEqual(updated.messages.map((message) => message.content), [
    'second user text',
    'second assistant text',
  ]);

  await assert.rejects(() => store.appendExchange({
    subject: 'cognito-user-1',
    matchId: 'another-match',
    sessionId: firstSessionId,
    exchangeId: 'exchange-3',
    userMessage: 'x',
    assistantMessage: 'y',
    policy,
  }), ChatSessionAccessError);
  await assert.rejects(() => store.appendExchange({
    subject: 'cognito-user-1',
    matchId: 'match-1',
    sessionId: secondSessionId,
    exchangeId: 'exchange-4',
    userMessage: 'x',
    assistantMessage: 'y',
    policy,
  }), ChatSessionLimitError);

  const summaries = await store.list('cognito-user-1');
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.sessionId, firstSessionId);
  assert.equal(summaries[0]?.scope, 'connection');
  assert.equal('matchId' in summaries[0]!, false);
  assert.equal(summaries[0]?.messageCount, 2);

  await store.delete('cognito-user-1', firstSessionId);
  assert.equal(await store.get('cognito-user-1', firstSessionId), undefined);
  assert.equal(
    [...container.blobs.keys()].filter((name) => name.startsWith('sessions/')).length,
    0,
  );
});

test('product-only sessions are isolated from every match scope', async () => {
  const container = new MemoryContainer();
  const store = new PlaintextChatSessionStore(container as unknown as ContainerClient);
  const session = await store.appendExchange({
    subject: 'cognito-user-1',
    sessionId: firstSessionId,
    exchangeId: 'product-exchange',
    userMessage: 'Tell me about OneHook',
    assistantMessage: 'OneHook helps with connections',
    policy,
  });
  assert.equal(session.matchId, undefined);
  assert.equal('matchId' in session, false);
  assert.notEqual(sessionScopeReference(), sessionScopeReference('product'));
  assert.notEqual(sessionScopeReference(), sessionScopeReference('match-1'));

  await assert.rejects(() => store.appendExchange({
    subject: 'cognito-user-1',
    matchId: 'match-1',
    sessionId: firstSessionId,
    exchangeId: 'connection-exchange',
    userMessage: 'Now use this match',
    assistantMessage: 'No',
    policy,
  }), ChatSessionAccessError);
});
