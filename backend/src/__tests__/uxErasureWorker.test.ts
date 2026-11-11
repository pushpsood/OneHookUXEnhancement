import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ContainerClient } from '@azure/storage-blob';
import { PlaintextChatSessionStore, stableReference } from '../plaintextChatSessionStore';
import { TableChatQuota, type QuotaTable } from '../chatQuota';
import {
  SqsErasureQueue,
  UxErasureWorker,
  createUserDataEraser,
  loadUxErasureConfig,
  parseUserDeletedMessage,
  type ErasureLogger,
  type ErasureQueue,
  type QueueMessage,
  type UserDataEraser,
} from '../uxErasureWorker';

// ── Fakes ───────────────────────────────────────────────────────────────────

class MemoryContainer {
  readonly blobs = new Map<string, Buffer>();
  readonly etags = new Map<string, string>();
  failDeletes = false;
  private nextEtag = 1;

  getBlockBlobClient(name: string) {
    return {
      exists: async () => this.blobs.has(name),
      downloadToBuffer: async () => Buffer.from(this.blobs.get(name)!),
      getProperties: async () => ({ etag: this.etags.get(name) }),
      deleteIfExists: async () => {
        if (this.failDeletes) throw Object.assign(new Error('storage down'), { statusCode: 503 });
        const deleted = this.blobs.delete(name);
        this.etags.delete(name);
        return { succeeded: deleted };
      },
      uploadData: async (data: Buffer, options?: { conditions?: { ifMatch?: string; ifNoneMatch?: string } }) => {
        if (options?.conditions?.ifNoneMatch === '*' && this.blobs.has(name)) {
          throw Object.assign(new Error('Precondition failed'), { statusCode: 412 });
        }
        if (options?.conditions?.ifMatch && options.conditions.ifMatch !== this.etags.get(name)) {
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

/** Table with list/delete by partition, 404 on a missing row. */
function memoryTable() {
  const rows = new Map<string, { partitionKey: string; rowKey: string; day: string; count: number; etag: string }>();
  let n = 0;
  const key = (pk: string, rk: string) => `${pk}|${rk}`;
  const err = (statusCode: number) => Object.assign(new Error(`status ${statusCode}`), { statusCode });
  let failDeletes = false;
  const table = {
    getEntity: async (pk: string, rk: string) => {
      const row = rows.get(key(pk, rk));
      if (!row) throw err(404);
      return { ...row };
    },
    createEntity: async (e: { partitionKey: string; rowKey: string; day: string; count: number }) => {
      if (rows.has(key(e.partitionKey, e.rowKey))) throw err(409);
      rows.set(key(e.partitionKey, e.rowKey), { ...e, etag: `e${++n}` });
      return {};
    },
    updateEntity: async (e: { partitionKey: string; rowKey: string; day: string; count: number }, _m: string, o: { etag: string }) => {
      const row = rows.get(key(e.partitionKey, e.rowKey));
      if (!row || row.etag !== o.etag) throw err(412);
      rows.set(key(e.partitionKey, e.rowKey), { ...e, etag: `e${++n}` });
      return {};
    },
    listEntities: (options: { queryOptions: { filter: string } }) => {
      const pk = /PartitionKey eq '([^']*)'/.exec(options.queryOptions.filter)?.[1];
      const matching = [...rows.values()].filter((row) => row.partitionKey === pk);
      return (async function* () { for (const row of matching) yield { rowKey: row.rowKey }; })();
    },
    deleteEntity: async (pk: string, rk: string) => {
      if (failDeletes) throw err(503);
      if (!rows.delete(key(pk, rk))) throw err(404);
      return {};
    },
  };
  return {
    table: table as unknown as QuotaTable,
    rows,
    failDeletes: (value: boolean) => { failDeletes = value; },
    addRow: (pk: string, rk: string) => rows.set(key(pk, rk), { partitionKey: pk, rowKey: rk, day: '2026-10-28', count: 3, etag: `e${++n}` }),
  };
}

function memoryLogger() {
  const events: Array<{ level: string } & Record<string, unknown>> = [];
  const logger: ErasureLogger = {
    info: (e) => events.push({ level: 'info', ...e }),
    warn: (e) => events.push({ level: 'warn', ...e }),
    error: (e) => events.push({ level: 'error', ...e }),
  };
  return { logger, events };
}

class FakeQueue implements ErasureQueue {
  readonly deleted: string[] = [];
  readonly released: string[] = [];
  readonly batches: QueueMessage[][] = [];
  receiveCalls: number[] = [];
  failDelete = false;
  failRelease = false;

  async receive(maxMessages: number, signal: AbortSignal): Promise<QueueMessage[]> {
    this.receiveCalls.push(maxMessages);
    const batch = this.batches.shift();
    if (batch) return batch;
    // Long poll: wait until aborted.
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }

  async delete(receiptHandle: string): Promise<void> {
    if (this.failDelete) throw new Error('sqs down');
    this.deleted.push(receiptHandle);
  }

  async release(receiptHandle: string): Promise<void> {
    if (this.failRelease) throw Object.assign(new Error('sqs down rh-secret'), { name: 'AccessDenied' });
    this.released.push(receiptHandle);
  }
}

const USER = 'cognito-sub-0b5c-erase-me';

function userDeleted(userId: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '0',
    id: 'evt-1',
    'detail-type': 'UserDeleted',
    source: 'club.onehook.profile',
    account: '123456789012',
    time: '2026-10-28T12:00:00Z',
    region: 'ap-south-1',
    resources: [],
    detail: { userId, timestamp: 1767000000 },
    ...overrides,
  });
}

const message = (body: string, receiveCount = 1, id = 'm-1'): QueueMessage =>
  ({ messageId: id, receiptHandle: `rh-${id}`, body, receiveCount });

const policy = { maxSessions: 3, maxMessages: 10, retentionDays: 30 };

async function seededStores() {
  const container = new MemoryContainer();
  const sessions = new PlaintextChatSessionStore(container as unknown as ContainerClient);
  for (const [subject, sessionId] of [
    [USER, '11111111-1111-4111-8111-111111111111'],
    [USER, '22222222-2222-4222-8222-222222222222'],
    ['someone-else', '33333333-3333-4333-8333-333333333333'],
  ] as const) {
    await sessions.appendExchange({
      subject, sessionId, exchangeId: `x-${sessionId}`, userMessage: 'hi', assistantMessage: 'hello', policy,
    });
  }
  const table = memoryTable();
  const quota = new TableChatQuota(table.table);
  await quota.consume(USER);
  await quota.consume('someone-else');
  return { container, sessions, table, quota };
}

// ── Message parsing ─────────────────────────────────────────────────────────

test('parses the EventBridge UserDeleted event delivered by the rule', () => {
  assert.deepEqual(parseUserDeletedMessage(userDeleted(USER)), { kind: 'erase', userId: USER });
});

test('malformed messages are classified, never erased', () => {
  assert.deepEqual(parseUserDeletedMessage('not json'), { kind: 'malformed', reason: 'NOT_JSON' });
  assert.deepEqual(parseUserDeletedMessage('[]'), { kind: 'malformed', reason: 'NOT_AN_EVENT' });
  assert.deepEqual(parseUserDeletedMessage('{"detail":{"userId":"u"}}'), { kind: 'malformed', reason: 'NOT_AN_EVENT' });
  for (const bad of [undefined, '', 42, 'has space', 'x'.repeat(257), 'tab\tid', null]) {
    assert.deepEqual(parseUserDeletedMessage(userDeleted(bad)), { kind: 'malformed', reason: 'INVALID_USER_ID' }, String(bad));
  }
  assert.deepEqual(parseUserDeletedMessage(userDeleted(USER, { detail: 'nope' })), { kind: 'malformed', reason: 'INVALID_USER_ID' });
});

test('events that are not a Profile UserDeleted are not ours', () => {
  assert.deepEqual(parseUserDeletedMessage(userDeleted(USER, { 'detail-type': 'ProfileUpdated' })), { kind: 'not-ours' });
  assert.deepEqual(parseUserDeletedMessage(userDeleted(USER, { source: 'onehook.state' })), { kind: 'not-ours' });
});

// ── Store erasure ───────────────────────────────────────────────────────────

test('session store erases every aisessions blob of the member (sessions and quota index) and nothing else', async () => {
  const { container, sessions } = await seededStores();
  const ref = stableReference(USER);
  assert.equal([...container.blobs.keys()].filter((n) => n.includes(ref)).length, 3, 'two sessions + one index');

  assert.equal(await sessions.eraseUser(USER), 3);
  assert.deepEqual([...container.blobs.keys()].filter((n) => n.includes(ref)), []);
  assert.equal((await sessions.list('someone-else')).length, 1, 'other members are untouched');
  assert.ok(container.blobs.has(`session-quotas/${stableReference('someone-else')}.json`));

  assert.equal(await sessions.eraseUser(USER), 0, 'idempotent');
});

test('quota ledger erasure deletes the member partition (sha256 hex of the id) and is idempotent', async () => {
  const { table, quota } = await seededStores();
  const pk = createHash('sha256').update(USER, 'utf8').digest('hex');
  table.addRow(pk, 'legacy-row');
  assert.equal(await quota.eraseUser(USER), 2);
  assert.equal([...table.rows.values()].filter((r) => r.partitionKey === pk).length, 0);
  assert.equal(table.rows.size, 1, 'other members keep their rows');
  assert.equal(await quota.eraseUser(USER), 0, 'nothing left, no error');
});

test('the composed eraser runs both stores and fails if either fails', async () => {
  const { container, sessions, table, quota } = await seededStores();
  table.failDeletes(true);
  await assert.rejects(() => createUserDataEraser(sessions, quota).eraseUser(USER));
  assert.equal([...container.blobs.keys()].filter((n) => n.includes(stableReference(USER))).length, 0,
    'sessions were still erased; the retry finishes the ledger');
  table.failDeletes(false);
  assert.deepEqual(await createUserDataEraser(sessions, quota).eraseUser(USER), { sessionBlobs: 0, ledgerRows: 1 });
  assert.deepEqual(await createUserDataEraser(sessions).eraseUser(USER), { sessionBlobs: 0, ledgerRows: 0 }, 'no table configured');
});

// ── Worker ──────────────────────────────────────────────────────────────────

test('worker erases sessions and ledger, then deletes the message', async () => {
  const { container, sessions, table, quota } = await seededStores();
  const queue = new FakeQueue();
  const { logger, events } = memoryLogger();
  const worker = new UxErasureWorker({ queue, eraser: createUserDataEraser(sessions, quota), logger });
  queue.batches.push([message(userDeleted(USER))]);

  assert.deepEqual(await worker.pollOnce(), ['erased']);
  assert.deepEqual(queue.deleted, ['rh-m-1']);
  assert.equal([...container.blobs.keys()].filter((n) => n.includes(stableReference(USER))).length, 0);
  assert.equal(table.rows.size, 1);
  const erased = events.find((e) => e.event === 'ux_erasure.erased');
  assert.deepEqual({ sessionBlobs: erased?.sessionBlobs, ledgerRows: erased?.ledgerRows }, { sessionBlobs: 3, ledgerRows: 1 });
  assert.equal(JSON.stringify(events).includes(USER), false, 'no member id in logs');
  assert.equal(JSON.stringify(events).includes(stableReference(USER)), false, 'no blob reference in logs');
});

test('a redelivered message is harmless (idempotent) and acknowledged', async () => {
  const { sessions, quota } = await seededStores();
  const queue = new FakeQueue();
  const worker = new UxErasureWorker({ queue, eraser: createUserDataEraser(sessions, quota), logger: memoryLogger().logger });
  queue.batches.push([message(userDeleted(USER), 1, 'a')], [message(userDeleted(USER), 2, 'a')]);
  assert.deepEqual(await worker.pollOnce(), ['erased']);
  assert.deepEqual(await worker.pollOnce(), ['erased']);
  assert.deepEqual(queue.deleted, ['rh-a', 'rh-a']);
});

test('on failure the message is left for retry; the last attempt logs that it moves to the DLQ', async () => {
  const { container, sessions, quota } = await seededStores();
  container.failDeletes = true;
  const queue = new FakeQueue();
  const { logger, events } = memoryLogger();
  const worker = new UxErasureWorker({ queue, eraser: createUserDataEraser(sessions, quota), logger, maxReceiveCount: 5 });
  queue.batches.push([message(userDeleted(USER), 1)], [message(userDeleted(USER), 5)]);

  assert.deepEqual(await worker.pollOnce(), ['failed']);
  assert.deepEqual(await worker.pollOnce(), ['failed']);
  assert.deepEqual(queue.deleted, [], 'never deleted on failure');
  assert.deepEqual(queue.released, [], 'a failed erasure keeps the normal visibility timeout (backoff)');
  const [first, last] = events.filter((e) => String(e.event).startsWith('ux_erasure.failed'));
  assert.deepEqual([first?.level, first?.event, first?.movesToDlq], ['warn', 'ux_erasure.failed', false]);
  assert.deepEqual([last?.level, last?.event, last?.movesToDlq], ['error', 'ux_erasure.failed_final', true]);
  assert.equal(first?.errorType, 'Error');
  assert.equal(JSON.stringify(events).includes('storage down'), false, 'error messages are not logged');
  assert.equal(JSON.stringify(events).includes(USER), false);
});

test('malformed messages erase nothing and are released at once to reach the DLQ; not-ours events are acknowledged', async () => {
  let erasures = 0;
  const eraser: UserDataEraser = { eraseUser: async () => { erasures += 1; return { sessionBlobs: 0, ledgerRows: 0 }; } };
  const queue = new FakeQueue();
  const { logger, events } = memoryLogger();
  const worker = new UxErasureWorker({ queue, eraser, logger });
  queue.batches.push([
    message('{{{', 1, 'bad-json'),
    message(userDeleted(''), 5, 'bad-id'),
    message(userDeleted(USER, { 'detail-type': 'ProfileUpdated' }), 1, 'other'),
  ]);
  assert.deepEqual(await worker.pollOnce(), ['malformed', 'malformed', 'not-ours']);
  assert.equal(erasures, 0);
  assert.deepEqual(queue.deleted, ['rh-other']);
  assert.deepEqual(queue.released, ['rh-bad-json', 'rh-bad-id'], 'only malformed messages are released');
  const malformed = events.filter((e) => e.event === 'ux_erasure.malformed');
  assert.deepEqual(malformed.map((e) => [e.reason, e.movesToDlq]), [['NOT_JSON', false], ['INVALID_USER_ID', true]]);
});

test('a failed release leaves the malformed message (never deleted) and logs the error type only', async () => {
  const queue = new FakeQueue();
  queue.failRelease = true;
  const { logger, events } = memoryLogger();
  const worker = new UxErasureWorker({
    queue, logger, eraser: { eraseUser: async () => ({ sessionBlobs: 0, ledgerRows: 0 }) },
  });
  queue.batches.push([message('not json', 2, 'bad')]);
  assert.deepEqual(await worker.pollOnce(), ['malformed']);
  assert.deepEqual(queue.deleted, []);
  assert.deepEqual(queue.released, []);
  const failed = events.filter((e) => e.event === 'ux_erasure.release_failed');
  assert.deepEqual(failed.map((e) => [e.level, e.messageId, e.receiveCount, e.errorType]), [['warn', 'bad', 2, 'AccessDenied']]);
  assert.equal(JSON.stringify(events).includes('sqs down'), false, 'error messages are not logged');
  assert.equal(JSON.stringify(events).includes('rh-'), false, 'receipt handles are not logged');
  assert.equal(JSON.stringify(events).includes('not json'), false, 'message bodies are not logged');
});

test('a poison message does not hold up the others in its batch', async () => {
  const eraser: UserDataEraser = {
    eraseUser: async (userId) => {
      if (userId === 'poison') throw new Error('always fails');
      return { sessionBlobs: 1, ledgerRows: 1 };
    },
  };
  const queue = new FakeQueue();
  const worker = new UxErasureWorker({ queue, eraser, logger: memoryLogger().logger });
  queue.batches.push([message(userDeleted('poison'), 3, 'p'), message(userDeleted('fine'), 1, 'f')]);
  assert.deepEqual(await worker.pollOnce(), ['failed', 'erased']);
  assert.deepEqual(queue.deleted, ['rh-f']);
});

test('a failed acknowledgement reports failure; the redelivery erases nothing new', async () => {
  const queue = new FakeQueue();
  queue.failDelete = true;
  const { logger, events } = memoryLogger();
  const worker = new UxErasureWorker({
    queue, eraser: { eraseUser: async () => ({ sessionBlobs: 0, ledgerRows: 0 }) }, logger,
  });
  queue.batches.push([message(userDeleted(USER))]);
  assert.deepEqual(await worker.pollOnce(), ['failed']);
  assert.ok(events.some((e) => e.event === 'ux_erasure.ack_failed'));
});

test('concurrency is bounded by the receive batch size', async () => {
  let inFlight = 0;
  let peak = 0;
  const eraser: UserDataEraser = {
    eraseUser: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { sessionBlobs: 0, ledgerRows: 0 };
    },
  };
  const queue = new FakeQueue();
  const worker = new UxErasureWorker({ queue, eraser, logger: memoryLogger().logger, concurrency: 2 });
  queue.batches.push([message(userDeleted('a'), 1, 'a'), message(userDeleted('b'), 1, 'b')]);
  await worker.pollOnce();
  assert.deepEqual(queue.receiveCalls, [2], 'asks SQS for at most `concurrency` messages');
  assert.equal(peak, 2);
  assert.equal(new UxErasureWorker({ queue, eraser, concurrency: 50 })['concurrency'], 10, 'capped at the SQS batch limit');
});

test('start polls in the background; stop aborts the long poll, drains and resolves', async () => {
  const queue = new FakeQueue();
  let erased = 0;
  const { logger, events } = memoryLogger();
  const worker = new UxErasureWorker({
    queue, logger, eraser: { eraseUser: async () => { erased += 1; return { sessionBlobs: 0, ledgerRows: 0 }; } },
  });
  queue.batches.push([message(userDeleted(USER))]);
  worker.start();
  worker.start(); // idempotent
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(erased, 1);
  await worker.stop(1_000);
  assert.deepEqual(events.filter((e) => e.event === 'ux_erasure.stopped').map((e) => e.drained), [true]);
  assert.equal(events.some((e) => e.event === 'ux_erasure.receive_failed'), false, 'the abort on stop is not an error');
});

test('a failing receive backs off and keeps polling', async () => {
  let calls = 0;
  const queue: ErasureQueue = {
    receive: async () => {
      calls += 1;
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    },
    delete: async () => {},
    release: async () => {},
  };
  const { logger, events } = memoryLogger();
  const worker = new UxErasureWorker({
    queue, logger, eraser: { eraseUser: async () => ({ sessionBlobs: 0, ledgerRows: 0 }) },
    initialBackoffMs: 2, maxBackoffMs: 4,
  });
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await worker.stop(1_000);
  assert.ok(calls >= 2, `retried (${calls} calls)`);
  const failures = events.filter((e) => e.event === 'ux_erasure.receive_failed');
  assert.equal(failures[0]?.errorType, 'ThrottlingException');
  assert.ok(failures.every((e) => Number(e.backoffMs) <= 4), 'backoff is capped');
});

// ── SQS adapter and config ──────────────────────────────────────────────────

test('SQS adapter long-polls the configured queue with the abort signal and maps receive counts', async () => {
  const sent: Array<{ command: string; input: Record<string, unknown>; options?: { abortSignal?: AbortSignal } }> = [];
  const client = {
    send: async (command: { input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => {
      sent.push({ command: command.constructor.name, input: command.input, ...(options ? { options } : {}) });
      if ('ReceiptHandle' in command.input) return {};
      return {
        Messages: [
          { MessageId: 'id-1', ReceiptHandle: 'rh-1', Body: '{}', Attributes: { ApproximateReceiveCount: '3' } },
          { MessageId: 'id-2', Body: 'no receipt handle, skipped' },
        ],
      };
    },
  };
  const url = 'https://sqs.ap-south-1.amazonaws.com/123456789012/OneHook-Matching-gamma-UxErasure';
  const queue = new SqsErasureQueue(client as never, url);
  const abort = new AbortController();
  assert.deepEqual(await queue.receive(4, abort.signal), [{ messageId: 'id-1', receiptHandle: 'rh-1', body: '{}', receiveCount: 3 }]);
  assert.deepEqual(sent[0]!.input, {
    QueueUrl: url, MaxNumberOfMessages: 4, WaitTimeSeconds: 20, MessageSystemAttributeNames: ['ApproximateReceiveCount'],
  });
  assert.equal(sent[0]!.options?.abortSignal, abort.signal);
  await queue.delete('rh-1');
  assert.deepEqual(sent[1]!.input, { QueueUrl: url, ReceiptHandle: 'rh-1' });
  assert.equal(sent[1]!.command, 'DeleteMessageCommand');
  await queue.release('rh-1');
  assert.deepEqual(sent[2]!.input, { QueueUrl: url, ReceiptHandle: 'rh-1', VisibilityTimeout: 0 });
  assert.equal(sent[2]!.command, 'ChangeMessageVisibilityCommand');
});

test('config: off without a queue URL, rejects a non-SQS URL, parses the region', () => {
  assert.deepEqual(loadUxErasureConfig({}), { configured: false, queueUrl: '', region: '', concurrency: 4, problems: [] });
  const bad = loadUxErasureConfig({ UX_ERASURE_QUEUE_URL: 'https://evil.example/123456789012/q' });
  assert.equal(bad.configured, false);
  assert.equal(bad.problems.length, 1);
  const good = loadUxErasureConfig({
    UX_ERASURE_QUEUE_URL: ' https://sqs.ap-south-1.amazonaws.com/627367419734/OneHook-Matching-gamma-UxErasure ',
    UX_ERASURE_CONCURRENCY: '6',
  });
  assert.deepEqual(good, {
    configured: true,
    queueUrl: 'https://sqs.ap-south-1.amazonaws.com/627367419734/OneHook-Matching-gamma-UxErasure',
    region: 'ap-south-1',
    concurrency: 6,
    problems: [],
  });
  assert.equal(loadUxErasureConfig({ UX_ERASURE_CONCURRENCY: '99' }).concurrency, 4);
});
