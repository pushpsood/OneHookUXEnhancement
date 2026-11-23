/**
 * Consumer-side checks of the assembled package (build/package), run before every publish:
 * its entry points resolve, the generated client sends each operation to the right path with the right
 * auth (Bearer ID token on member routes, none on public ones), and "./manifest" lists every operation.
 * Requests go to a capturing handler; nothing reaches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('../build/package/', import.meta.url));
const require = createRequire(pkgDir);
const { MrOneHookService, ProductConnectionChatCommand } = require(pkgDir);
const { API_OPERATIONS } = require(`${pkgDir}dist-cjs/manifest/index.js`);
const pkg = require(`${pkgDir}package.json`);

function capturing(captured, respond) {
  return {
    handle: async (request) => {
      const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
      captured.push({ method: request.method, path: request.path, authorization: headers.authorization, headers, body: request.body });
      const text = JSON.stringify(respond(request.path));
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) }),
        },
      };
    },
  };
}

test('exports the client, its commands and the manifest', () => {
  assert.equal(pkg.name, 'onehook-mr-onehook-client');
  assert.ok(MrOneHookService && ProductConnectionChatCommand);
  for (const sub of ['.', './manifest', './manifest/Manifest.swift', './manifest/Manifest.kt', './openapi/*']) {
    assert.ok(pkg.exports[sub], sub);
  }
});

test('member routes carry the Bearer token; the public routes carry none', async () => {
  const captured = [];
  const client = new MrOneHookService({
    endpoint: 'https://chatbot.gamma.onehook.club',
    token: async () => ({ token: 'member-id-token' }),
    requestHandler: capturing(captured, (path) =>
      path.endsWith('/sessions') ? { sessions: [] } : { reply: 'Hi!', mood: 'Happy', needsMoreContext: false }
    ),
  });
  const turn = await client.productConnectionChat({ message: 'What is OneHook?', contextOptions: { includeProfile: true } });
  assert.equal(turn.reply, 'Hi!');
  await client.listChatSessions({});
  await client.deleteChatSession({ sessionId: 's-1' });
  await client.publicProductChat({ messages: [{ role: 'user', content: 'Hello' }] });

  assert.deepEqual(captured.map((c) => `${c.method} ${c.path}`), [
    'POST /api/member/product-connection-chat',
    'GET /api/member/product-connection-chat/sessions',
    'DELETE /api/member/product-connection-chat/sessions/s-1',
    'POST /api/public/product-chat',
  ]);
  for (const c of captured.slice(0, 3)) assert.equal(c.authorization, 'Bearer member-id-token', c.path);
  assert.equal(captured[3].authorization, undefined);
  assert.deepEqual(JSON.parse(captured[0].body), { message: 'What is OneHook?', contextOptions: { includeProfile: true } });
});

test('the manifest lists every operation with its auth', () => {
  assert.deepEqual(
    API_OPERATIONS.map((o) => `${o.auth} ${o.method} ${o.path} ${o.operationId}`),
    [
      'cognito GET /api/member/mr-onehook-pro GetMrOneHookPro',
      'cognito DELETE /api/member/mr-onehook-pro/continuation CancelMrOneHookProContinuation',
      'cognito PUT /api/member/mr-onehook-pro/continuation ContinueMrOneHookProAfterMembership',
      'cognito DELETE /api/member/mr-onehook-pro/notices/{noticeId} DismissMrOneHookProNotice',
      'cognito POST /api/member/mr-onehook-pro/subscription PurchaseMrOneHookPro',
      'cognito PUT /api/member/mr-onehook-pro/subscription/auto-renew UpdateMrOneHookProAutoRenew',
      'cognito POST /api/member/product-connection-chat ProductConnectionChat',
      'cognito POST /api/member/product-connection-chat/attachments UploadChatAttachment',
      'cognito GET /api/member/product-connection-chat/attachments/{attachmentId} GetChatAttachment',
      'cognito GET /api/member/product-connection-chat/attachments/{attachmentId}/content GetChatAttachmentContent',
      'cognito GET /api/member/product-connection-chat/sessions ListChatSessions',
      'cognito DELETE /api/member/product-connection-chat/sessions/{sessionId} DeleteChatSession',
      'cognito GET /api/member/product-connection-chat/sessions/{sessionId} GetChatSession',
      'none POST /api/public/product-chat PublicProductChat',
      'none GET /health GetHealth',
    ]
  );
  assert.ok(API_OPERATIONS.every((o) => o.service === 'mr-onehook'));
});

test('an attachment upload sends the raw bytes with its headers; a Pro purchase sends the idempotency key', async () => {
  const captured = [];
  const client = new MrOneHookService({
    endpoint: 'https://chatbot.gamma.onehook.club',
    token: async () => ({ token: 'member-id-token' }),
    requestHandler: capturing(captured, (path) =>
      path.endsWith('/attachments')
        ? { attachment: { attachmentId: 'a-1', name: 'menu.png', kind: 'image', mediaType: 'image/png', sizeBytes: 3, status: 'PROCESSING', source: 'upload', createdAt: 'x', expiresAt: 'y' } }
        : { plan: 'PRO', source: 'SUBSCRIPTION', canPurchase: false, offers: [], limits: { maxSessions: 3, attachmentsAllowed: true, maxAttachmentBytes: 5242880, maxAttachmentsPerMessage: 3 }, notices: [] }
    ),
  });
  const uploaded = await client.uploadChatAttachment({
    contentType: 'image/png', fileName: encodeURIComponent('menu.png'), body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(uploaded.attachment.status, 'PROCESSING');
  await client.purchaseMrOneHookPro({ idempotencyKey: '11111111-1111-4111-8111-111111111111', billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' });
  assert.equal(captured[0].path, '/api/member/product-connection-chat/attachments');
  assert.equal(captured[0].headers['content-type'], 'image/png');
  assert.equal(captured[0].headers['x-attachment-name'], 'menu.png');
  assert.equal(captured[1].headers['idempotency-key'], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(JSON.parse(captured[1].body), { billingPeriod: 'MONTHLY', paymentToken: 'fake-ok' });
});
