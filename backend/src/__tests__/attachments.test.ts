import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { detectAttachmentType, zipEntryNames } from '../attachmentTypes';
import { AttachmentUsageLedger } from '../attachmentUsage';
import { AttachmentExtractionError, AttachmentProcessingQueue, AttachmentProcessor, estimateCostMilli } from '../attachmentProcessor';
import { AttachmentStore, type AttachmentRecord } from '../attachmentStore';
import { DEFAULT_ATTACHMENT_RATES, loadContextualFeatureConfig } from '../contextConfig';
import { PlaintextChatSessionStore, stableReference } from '../plaintextChatSessionStore';
import { ProStore } from '../proStore';
import { createApp } from '../app';
import { createUserDataEraser } from '../uxErasureWorker';
import { MatchContextAccessError } from '../oneHookDataClient';
import { MemoryProTable, manualClock } from './helpers/memoryProTable';
import { MemoryContainer } from './helpers/memoryContainer';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** A ZIP with these entries (stored, empty data; `uncompressed` is what the directory claims). */
function zip(entries: Array<[string, number?]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, uncompressed = 0] of entries) {
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(n.length, 26);
    n.copy(local, 30);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    n.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const hex = (h: string) => Buffer.from(h.replace(/\s/g, ''), 'hex');
const ftyp = (major: string, brands: string[] = []) => {
  const b = Buffer.alloc(16 + brands.length * 4);
  b.writeUInt32BE(b.length, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(major, 8, 'latin1');
  brands.forEach((brand, i) => b.write(brand, 16 + i * 4, 'latin1'));
  return Buffer.concat([b, Buffer.alloc(32)]);
};

test('file types come from the bytes; names and declared types are only hints', () => {
  const kind = (bytes: Buffer, type = 'application/octet-stream', name = 'file') => {
    const d = detectAttachmentType(bytes, type, name);
    return d ? `${d.kind} ${d.mediaType} ${d.reader}` : 'refused';
  };
  assert.equal(kind(hex('89504e470d0a1a0a0000')), 'image image/png vision');
  assert.equal(kind(hex('ffd8ffe000104a464946')), 'image image/jpeg vision');
  assert.equal(kind(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.alloc(8)])), 'image image/webp vision');
  assert.equal(kind(ftyp('heic', ['mif1'])), 'image image/heic document');
  assert.equal(kind(Buffer.from('%PDF-1.7\n...')), 'document application/pdf document');
  assert.equal(kind(zip([['[Content_Types].xml'], ['word/document.xml']])), 'document application/vnd.openxmlformats-officedocument.wordprocessingml.document document');
  assert.equal(kind(zip([['[Content_Types].xml'], ['xl/workbook.xml']])), 'document application/vnd.openxmlformats-officedocument.spreadsheetml.sheet document');
  assert.equal(kind(zip([['[Content_Types].xml'], ['ppt/presentation.xml']])), 'document application/vnd.openxmlformats-officedocument.presentationml.presentation document');
  assert.equal(kind(Buffer.from('ID3\x04\0\0\0\0\0\0')), 'audio audio/mpeg transcription');
  assert.equal(kind(ftyp('M4A ')), 'audio audio/mp4 transcription');
  assert.equal(kind(ftyp('isom', ['mp41'])), 'video video/mp4 video');
  assert.equal(kind(ftyp('qt  ')), 'video video/quicktime video');
  assert.equal(kind(hex('1a45dfa30000'), 'audio/webm'), 'audio audio/webm transcription', 'a voice note in WebM');
  assert.equal(kind(hex('1a45dfa30000'), 'video/webm'), 'video video/webm video');
  assert.equal(kind(Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(8)])), 'audio audio/wav transcription');
  assert.equal(kind(Buffer.from('OggS\0\x02')), 'audio audio/ogg transcription');
  assert.equal(kind(Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHello'), 'text/vtt', 'call.vtt'), 'text text/vtt text');
  assert.equal(kind(Buffer.from('name,age\nAda,36\n'), 'text/csv', 'people.csv'), 'text text/csv text');
  assert.equal(kind(Buffer.from('नमस्ते, kaise ho?'), 'text/plain', 'note.txt'), 'text text/plain text', 'UTF-8 text');
  // Refused: executables (whatever they are called), other archives, bombs, binary "text", AAC ADTS.
  assert.equal(kind(hex('4d5a9000030000000400'), 'application/pdf', 'cv.pdf'), 'refused');
  assert.equal(kind(hex('7f454c46020101000000'), 'text/plain', 'notes.txt'), 'refused');
  assert.equal(kind(zip([['payload.exe']]), 'application/zip', 'photos.zip'), 'refused');
  assert.equal(kind(zip([['[Content_Types].xml', 0xfffffff0], ['word/a.xml', 0xfffffff0]])), 'refused', 'zip bomb');
  assert.equal(kind(Buffer.from([0x00, 0x01, 0x02, 0xff]), 'text/plain', 'a.txt'), 'refused');
  assert.equal(kind(hex('fff15080')), 'refused', 'raw AAC is not accepted by the transcription service');
  assert.deepEqual(zipEntryNames(Buffer.from('PK\x03\x04 not really a zip')), undefined);
});

test('allowance: a burst limit and a monthly budget, reserved before processing so concurrent uploads cannot overshoot', async () => {
  const clock = manualClock('2026-11-20T10:00:00.000Z');
  const ledger = new AttachmentUsageLedger(new ProStore(new MemoryProTable()), { burstFiles: 3, burstWindowMs: 600_000 }, clock.now);
  for (let i = 0; i < 3; i++) assert.equal((await ledger.reserve('m1', 1_000, 10_000)).allowed, true);
  const burst = await ledger.reserve('m1', 1_000, 10_000);
  assert.deepEqual(burst, { allowed: false, retryAt: '2026-11-20T10:10:00.000Z', reason: 'BURST' });
  clock.advance(600_001);
  // Budget Rs 10 (1000 paise = 1,000,000 milli-paise): 3 x 10,000 reserved; 97 more fit.
  const results = await Promise.all(Array.from({ length: 3 }, () => ledger.reserve('m2', 10, 4_000)));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, false], 'Rs 0.10 budget: two Rs 0.04 files fit, the third does not');
  const refused = results[2]!;
  assert.ok(!refused.allowed && refused.reason === 'BUDGET' && refused.retryAt === '2026-12-01T00:00:00.000Z');
  // Settling with the real (lower) cost frees the difference.
  await ledger.settle('m2', '2026-11', 4_000, 500);
  assert.equal((await ledger.reserve('m2', 10, 3_000)).allowed, true);
  // The warning is reported once, when 80% is crossed.
  const w = new AttachmentUsageLedger(new ProStore(new MemoryProTable()), { burstFiles: 100, burstWindowMs: 600_000 }, clock.now);
  const first = await w.reserve('m3', 10, 8_000);
  const second = await w.reserve('m3', 10, 1_000);
  assert.ok(first.allowed && first.crossedWarning && second.allowed && second.warning && !second.crossedWarning);
  assert.equal(await w.usedPercent('m3', 10), 90);
});

const record = (over: Partial<AttachmentRecord>): AttachmentRecord => ({
  schemaVersion: 1, attachmentId: randomUUID(), userRef: stableReference('m1'), name: 'f', kind: 'text', mediaType: 'text/plain',
  reader: 'text', extension: 'txt', sizeBytes: 10, source: 'upload', status: 'PROCESSING', place: 'pending',
  createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  usage: { month: '2026-11', reservedMilli: 0, settled: false, budgetMinor: 40_000 }, ...over,
});

test('extraction reads every kind and meters what it cost', async () => {
  const frames = [new Uint8Array([1]), new Uint8Array([2])];
  const processor = new AttachmentProcessor({
    vision: { describe: async (images) => ({ text: `${images.length} image(s): a menu. TEXT: Coffee 120`, inputTokens: 1_000, outputTokens: 100 }) },
    transcriber: { transcribe: async () => ({ text: 'see you at eight', seconds: 120 }) },
    documents: { read: async () => ({ text: 'Lease agreement, page 1', pages: 4 }) },
    frames: { frames: async () => frames },
  }, DEFAULT_ATTACHMENT_RATES, 50);
  const text = await processor.extract(record({}), Buffer.from('hello there'));
  assert.deepEqual(text, { text: 'hello there', truncated: false, costMilli: 0 });
  const image = await processor.extract(record({ kind: 'image', reader: 'vision', mediaType: 'image/png' }), Buffer.from([1]));
  assert.equal(image.costMilli, Math.ceil((1_000 * 21_000 + 100 * 84_000) / 1000));
  const doc = await processor.extract(record({ kind: 'document', reader: 'document' }), Buffer.from([1]));
  assert.equal(doc.costMilli, Math.ceil(4 * 12.6 * 1000));
  const audio = await processor.extract(record({ kind: 'audio', reader: 'transcription' }), Buffer.from([1]));
  assert.deepEqual([audio.text, audio.costMilli], ['see you at eight', 2 * 50 * 1000]);
  const video = await processor.extract(record({ kind: 'video', reader: 'video', extension: 'mov' }), Buffer.from([1]));
  assert.match(video.text, /WHAT THE VIDEO SHOWS:\n2 image\(s\)[\s\S]*WHAT IS SAID:\nsee you at eight/);
  // Long text is cut, and said so.
  const long = await processor.extract(record({}), Buffer.from('x'.repeat(30_000)));
  assert.deepEqual([long.text.length, long.truncated], [20_000, true]);
  await assert.rejects(processor.extract(record({}), Buffer.from('   ')), (e: unknown) => e instanceof AttachmentExtractionError && e.reason === 'UNREADABLE');
  // Without a transcription deployment, audio is not accepted at upload.
  const visionOnly = new AttachmentProcessor({ vision: { describe: async () => ({ text: 'x', inputTokens: 0, outputTokens: 0 }) } }, DEFAULT_ATTACHMENT_RATES, 50);
  assert.deepEqual(['text', 'vision', 'document', 'transcription', 'video'].map((r) => visionOnly.supports(r as never)), [true, true, false, false, false]);
  // The reservation covers the worst case of each kind.
  assert.ok(estimateCostMilli('image', 'vision', 1, DEFAULT_ATTACHMENT_RATES, 50) >= image.costMilli);
  assert.ok(estimateCostMilli('audio', 'transcription', 240_000, DEFAULT_ATTACHMENT_RATES, 50) >= audio.costMilli);
});

test('processing settles the reservation exactly once; a failure is FAILED with a reason and costs nothing', async () => {
  const container = new MemoryContainer();
  const store = new AttachmentStore(container.asContainer());
  const table = new MemoryProTable();
  const ledger = new AttachmentUsageLedger(new ProStore(table), { burstFiles: 100, burstWindowMs: 600_000 });
  const processor = new AttachmentProcessor({
    vision: { describe: async () => { throw Object.assign(new Error('bad image'), { status: 400 }); } },
  }, DEFAULT_ATTACHMENT_RATES, 50);
  const queue = new AttachmentProcessingQueue(store, processor, ledger, 2, quiet);
  const reserve = async () => {
    const d = await ledger.reserve('m1', 40_000, 5_000);
    assert.ok(d.allowed);
    return d.month;
  };
  const month = await reserve();
  const ok = record({ usage: { month, reservedMilli: 5_000, settled: false, budgetMinor: 40_000 } });
  await store.create('m1', ok, Buffer.from('a packing list'));
  await reserve();
  const broken = record({ kind: 'image', reader: 'vision', mediaType: 'image/png', usage: { month, reservedMilli: 5_000, settled: false, budgetMinor: 40_000 } });
  await store.create('m1', broken, Buffer.from([1]));
  queue.enqueue('m1', ok.attachmentId, true);
  queue.enqueue('m1', broken.attachmentId, true);
  queue.enqueue('m1', ok.attachmentId, true); // duplicate: ignored
  await queue.idle();
  const done = await store.get('m1', ok.attachmentId);
  assert.deepEqual([done!.record.status, done!.record.extracted!.text, done!.record.usage.settled], ['READY', 'a packing list', true]);
  const failed = await store.get('m1', broken.attachmentId);
  assert.deepEqual([failed!.record.status, failed!.record.failureReason], ['FAILED', 'UNREADABLE']);
  // Both reservations released; only real cost (0 here) spent.
  const usage = table.docs('usage:')[0] as { reservedMilli: number; spentMilli: number };
  assert.deepEqual([usage.reservedMilli, usage.spentMilli], [0, 0]);
  // Re-processing a finished file does nothing (and settles nothing again).
  queue.enqueue('m1', ok.attachmentId);
  await queue.idle();
  assert.equal((table.docs('usage:')[0] as { reservedMilli: number }).reservedMilli, 0);
});

test('an interrupted file (lease expired) is taken over; one still leased elsewhere is left alone', async () => {
  const container = new MemoryContainer();
  const store = new AttachmentStore(container.asContainer());
  const ledger = new AttachmentUsageLedger(new ProStore(new MemoryProTable()), { burstFiles: 100, burstWindowMs: 600_000 });
  const processor = new AttachmentProcessor({ vision: { describe: async () => ({ text: 'x', inputTokens: 0, outputTokens: 0 }) } }, DEFAULT_ATTACHMENT_RATES, 50);
  const queue = new AttachmentProcessingQueue(store, processor, ledger, 2, quiet);
  const abandoned = record({ leaseUntil: '2026-01-01T00:00:00.000Z', usage: { month: '2026-11', reservedMilli: 0, settled: true, budgetMinor: 1 } });
  const leased = record({ leaseUntil: '2099-01-01T00:00:00.000Z', usage: { month: '2026-11', reservedMilli: 0, settled: true, budgetMinor: 1 } });
  await store.create('m1', abandoned, Buffer.from('a'));
  await store.create('m1', leased, Buffer.from('b'));
  assert.deepEqual([queue.isAbandoned(abandoned), queue.isAbandoned(leased)], [true, false]);
  queue.enqueue('m1', abandoned.attachmentId);
  queue.enqueue('m1', leased.attachmentId);
  await queue.idle();
  assert.equal((await store.get('m1', abandoned.attachmentId))!.record.status, 'READY');
  assert.equal((await store.get('m1', leased.attachmentId))!.record.status, 'PROCESSING');
});

test('attachment storage: member-bound, hashed names, moved into a saved session, expired files gone, erasure complete', async () => {
  const container = new MemoryContainer();
  const store = new AttachmentStore(container.asContainer());
  const own = { userRef: stableReference('member-raw-id') };
  const a = record({ name: 'menu.png', ...own });
  await store.create('member-raw-id', a, Buffer.from('bytes'));
  assert.ok(container.names().every((n) => !n.includes('member-raw-id') && !n.includes(a.attachmentId) && !n.includes('menu')));
  assert.equal(await store.get('someone-else', a.attachmentId), undefined, 'another member never finds it');
  const found = (await store.get('member-raw-id', a.attachmentId))!;
  await store.save('member-raw-id', found, '11111111-1111-4111-8111-111111111111', '2099-01-01T00:00:00.000Z');
  const moved = (await store.get('member-raw-id', a.attachmentId))!;
  assert.deepEqual([moved.record.place, moved.record.sessionId], ['saved', '11111111-1111-4111-8111-111111111111']);
  assert.equal(container.names('attachments/pending/').length, 0);
  assert.equal((await store.content('member-raw-id', moved.record)).toString(), 'bytes');
  const expired = record({ expiresAt: '2020-01-01T00:00:00.000Z', ...own });
  await store.create('member-raw-id', expired, Buffer.from('old'));
  assert.equal(await store.get('member-raw-id', expired.attachmentId), undefined);
  assert.equal(container.names(`attachments/pending/${stableReference('member-raw-id')}/${stableReference(expired.attachmentId)}`).length, 0);
  await store.create('member-raw-id', record({ place: 'ephemeral', source: 'match_chat', ...own }), Buffer.from('x'));
  // A record copied into another member's folder is refused, never served.
  const stray = record({ ...own });
  await store.create('member-raw-id', stray, Buffer.from('x'));
  const strayName = `attachments/pending/${stableReference('member-raw-id')}/${stableReference(stray.attachmentId)}.json`;
  container.blobs.set(`attachments/pending/${stableReference('intruder')}/${stableReference(stray.attachmentId)}.json`, container.blobs.get(strayName)!);
  container.etags.set(`attachments/pending/${stableReference('intruder')}/${stableReference(stray.attachmentId)}.json`, 'x');
  await assert.rejects(store.get('intruder', stray.attachmentId), /binding mismatch/);
  container.blobs.delete(`attachments/pending/${stableReference('intruder')}/${stableReference(stray.attachmentId)}.json`);
  const removed = await store.eraseUser('member-raw-id');
  assert.ok(removed >= 4);
  assert.deepEqual(container.names('attachments/'), []);
});

test('sessions keep file references and excerpts; deleting, expiring or sliding a turn out deletes its files', async () => {
  const container = new MemoryContainer();
  const deleted: string[] = [];
  const sessions = new PlaintextChatSessionStore(container.asContainer(), {
    onSessionDeleted: async (_subject, ids) => { deleted.push(...ids); },
  });
  const policy = { maxSessions: 3, maxMessages: 2, retentionDays: 30 };
  const id1 = randomUUID();
  const id2 = randomUUID();
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const turn = (exchangeId: string, attachmentId: string) => sessions.appendExchange({
    subject: 'm1', sessionId, exchangeId, userMessage: 'what is this?', assistantMessage: 'A menu.', policy,
    userAttachments: [{ attachmentId, name: 'menu.png', kind: 'image', sizeBytes: 10, source: 'upload', excerpt: 'Coffee 120' }],
  });
  const first = await turn('e1', id1);
  assert.deepEqual(first.messages[0]!.attachments, [{ name: 'menu.png', kind: 'image', source: 'upload', attachmentId: id1, sizeBytes: 10, excerpt: 'Coffee 120' }]);
  await turn('e2', id2); // maxMessages 2: the first turn slides out of the window
  assert.deepEqual(deleted, [id1]);
  await sessions.delete('m1', sessionId);
  assert.deepEqual(deleted, [id1, id2]);
});

// ── Route: files from a match chat, end to end through the HTTP app ──────────

test('a file the match sent is used for one turn of that connection chat, then deleted; it is never saved', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((ok) => jwks.listen(0, '127.0.0.1', ok));
  const config = loadContextualFeatureConfig({
    CONTEXTUAL_AI_ENABLED: 'true', AUTH_ISSUER: 'https://issuer.test', AUTH_AUDIENCE: 'aud',
    AUTH_JWKS_URI: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`,
    CORS_ALLOWED_ORIGINS: 'https://x', ONEHOOK_DATA_API_URL: 'https://data', AZURE_STORAGE_ACCOUNT: 'acct',
    AZURE_SESSION_CONTAINER: 'c', ONEHOOK_DATA_API_AWS_REGION: 'ap-south-1', CHAT_SESSION_STORAGE_ENABLED: 'true',
    CHAT_SESSION_PLAN_POLICIES: JSON.stringify({ pro: { enabled: true, maxSessions: 3, maxMessages: 50, retentionDays: 30 }, free: { enabled: true, maxSessions: 1, maxMessages: 50, retentionDays: 30 } }),
    AZURE_PRO_TABLE: 'pro', CHAT_ATTACHMENTS_ENABLED: 'true',
  } as NodeJS.ProcessEnv);
  const container = new MemoryContainer();
  const attachmentStore = new AttachmentStore(container.asContainer());
  const sessionStore = new PlaintextChatSessionStore(container.asContainer(), {
    onSessionDeleted: async (subject, ids) => { for (const id of ids) await attachmentStore.delete(subject, id); },
  });
  const proStore = new ProStore(new MemoryProTable());
  const processor = new AttachmentProcessor({
    vision: { describe: async () => ({ text: 'A beach photo. TEXT: Goa 2025', inputTokens: 500, outputTokens: 50 }) },
  }, config.attachments.rates, 50);
  const usage = new AttachmentUsageLedger(proStore, config.attachments);
  const queue = new AttachmentProcessingQueue(attachmentStore, processor, usage, 2, quiet);
  const prompts: string[] = [];
  const model = {
    chat: {
      completions: {
        create: async (p: { messages: Array<{ content: string }> }) => {
          prompts.push(p.messages[0]!.content);
          return { choices: [{ message: { content: JSON.stringify({ reply: 'Looks like Goa!', mood: 'Happy' }) } }] };
        },
      },
    },
  };
  const dataClient = {
    getAiVisibleMatch: async (_s: string, matchId: string) => {
      if (matchId === 'm-gone') throw new MatchContextAccessError('gone');
      return {
        matchId, status: 'active' as const, requestingUser: { displayName: 'Ada' }, matchedUser: { displayName: 'Grace' },
        profileAllowed: true, messageHistoryAllowed: matchId !== 'm-private', policyVersion: '1',
      };
    },
  };
  const server = createApp({
    corsAllowedOrigins: [], contextualConfig: config,
    publicChat: { client: model as never, deployment: 'd', productContextProvider: async () => '' },
    contextualServices: {
      client: model as never, deployment: 'd', dataClient: dataClient as never, sessionStore,
      productContextProvider: async () => '', attachments: { store: attachmentStore, processor, usage, queue },
      chatQuota: { consume: async () => ({ allowed: true, remaining: 9 }), release: async () => {} },
    },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((ok) => (server.listening ? ok() : server.once('listening', ok)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = async (tier: string) => `Bearer ${await new SignJWT({ 'custom:subscriptionTier': tier })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('ada').setIssuer('https://issuer.test').setAudience('aud')
    .setIssuedAt().setExpirationTime('5m').sign(privateKey)}`;
  const upload = async (headers: Record<string, string>, tier = 'INFINITY') => {
    const r = await fetch(`${base}/api/member/product-connection-chat/attachments`, {
      method: 'POST',
      headers: { authorization: await auth(tier), 'content-type': 'image/png', 'x-attachment-name': 'beach.png', ...headers },
      body: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])]),
    });
    return { status: r.status, body: await r.json() as any };
  };
  const send = async (body: Record<string, unknown>) => {
    const r = await fetch(`${base}/api/member/product-connection-chat`, {
      method: 'POST', headers: { authorization: await auth('INFINITY'), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    assert.equal((await upload({ 'x-attachment-match-id': 'm-ok' })).status, 400, 'a match-chat file says who sent it');
    assert.equal((await upload({ 'x-attachment-match-id': 'm-private', 'x-attachment-sender': 'match' })).body.error, 'MESSAGE_CONTEXT_NOT_ALLOWED');
    assert.equal((await upload({ 'x-attachment-match-id': 'm-private', 'x-attachment-sender': 'self' })).status, 202, 'their own file is fine');
    assert.equal((await upload({}, 'MUST')).body.error, 'PRO_REQUIRED', 'Must and Super may select files, but sending needs Pro');
    const fromMatch = await upload({ 'x-attachment-match-id': 'm-ok', 'x-attachment-sender': 'match' });
    assert.equal(fromMatch.status, 202);
    assert.deepEqual([fromMatch.body.attachment.source, fromMatch.body.attachment.sender], ['match_chat', 'match']);
    const id = fromMatch.body.attachment.attachmentId as string;
    await queue.idle();

    assert.equal((await send({ message: 'where is this?', attachmentIds: [id] })).body.error, 'ATTACHMENT_NOT_USABLE', 'not in a product chat');
    assert.equal((await send({ message: 'where is this?', matchId: 'm-other', attachmentIds: [id] })).body.error, 'ATTACHMENT_NOT_USABLE', 'not in another match');
    assert.equal((await send({ message: 'where is this?', matchId: 'm-ok', contextOptions: { includeMessageHistory: false }, attachmentIds: [id] })).status, 403);

    const turn = await send({ message: 'where is this?', matchId: 'm-ok', attachmentIds: [id], sessionOptions: { persist: true } });
    assert.equal(turn.status, 200, JSON.stringify(turn.body));
    assert.equal(turn.body.contextUsed.attachmentCount, 1);
    assert.match(prompts.at(-1)!, /"sharedBy":"your match","content":"A beach photo\. TEXT: Goa 2025"/);
    // Deleted after the turn; the saved session names the file but keeps neither an id nor its content.
    assert.deepEqual(container.names('attachments/ephemeral/').filter((n) => n.includes(stableReference(id))), []);
    const saved = (await sessionStore.get('ada', turn.body.session.sessionId))!;
    assert.deepEqual(saved.messages[0]!.attachments, [{ name: 'beach.png', kind: 'image', source: 'match_chat' }]);
    assert.ok(!JSON.stringify(saved).includes('beach photo') && !JSON.stringify(saved).includes('Goa 2025'), 'nothing of the match file is stored');
    assert.equal((await send({ message: 'again?', matchId: 'm-ok', attachmentIds: [id] })).body.error, 'ATTACHMENT_NOT_FOUND', 'one turn only');

    // The account erasure worker removes sessions and every attachment of the member.
    const erased = await createUserDataEraser(sessionStore, undefined, { attachments: attachmentStore }).eraseUser('ada');
    assert.ok((erased.attachmentBlobs ?? 0) >= 2, 'the unsent upload is erased too');
    assert.deepEqual(container.names(), []);
  } finally {
    server.close();
    jwks.close();
  }
});
