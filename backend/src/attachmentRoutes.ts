import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { ContextualFeatureConfig } from './contextConfig';
import type { ContextualServices } from './contextRoutes';
import type { ExcerptSpeaker } from './generated/mrOneHookModels';
import { createPrincipalRateLimiter, pathParam } from './memberRouting';
import type { ProEntitlement } from './proSubscriptionService';
import { ProStoreUnavailableError } from './proStore';
import { detectAttachmentType } from './attachmentTypes';
import { estimateCostMilli } from './attachmentProcessor';
import { AttachmentAccessError, toChatAttachment, type AttachmentRecord } from './attachmentStore';
import { AttachmentUsageUnavailableError } from './attachmentUsage';
import { MatchContextAccessError, MatchContextUnavailableError } from './oneHookDataClient';
import { isUuid } from './contextTypes';
import { stableReference } from './plaintextChatSessionStore';

/**
 * Chat attachments (Mr OneHook Pro, signed-in chats only; the public homepage chat has none):
 *
 *   POST .../attachments                     raw file (5 MiB), 202 PROCESSING; read in the background
 *   GET  .../attachments/:attachmentId        status (poll until READY; 60 per minute of its own)
 *   GET  .../attachments/:attachmentId/content  the bytes of the member's own upload (never match-chat files)
 *
 * Order of checks on upload, cheapest first and before the body is read: token, rate limit, attachments
 * configured, plan is Pro, headers. Then the body (streamed, 5 MiB cap), the type from the bytes, the match
 * (for a match-chat file), the allowance (burst and monthly budget). Only then is anything stored.
 */
export interface AttachmentRouteDeps {
  config: ContextualFeatureConfig;
  services: ContextualServices;
  authenticateUser: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  userRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  planOf: (req: Request) => Promise<ProEntitlement>;
}

const UPLOAD_PATH = '/api/member/product-connection-chat/attachments';
/** Unsent uploads and match-chat files live a day (the storage lifecycle rule also removes them). */
const ATTACHMENT_TTL_MS = 24 * 3_600_000;

/** The upload route reads its own raw body; the app's JSON parser must leave it alone. */
export function isAttachmentUpload(req: Request): boolean {
  return req.method === 'POST' && req.path === UPLOAD_PATH;
}

export function registerUnavailableAttachmentRoutes(router: Router, status: number, error: string): void {
  router.post('/api/member/product-connection-chat/attachments', (_req, res) => {
    res.status(status).json({ error });
  });
  router.get('/api/member/product-connection-chat/attachments/:attachmentId', (_req, res) => {
    res.status(status).json({ error });
  });
  router.get('/api/member/product-connection-chat/attachments/:attachmentId/content', (_req, res) => {
    res.status(status).json({ error });
  });
}

function decodeFileName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  // No paths, no control characters; 1 to 255 characters.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^.*[\\/]/, '').trim();
  return name.length >= 1 && name.length <= 255 ? name : undefined;
}

/** `attachment; filename*=UTF-8''...` with a plain ASCII fallback. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerAttachmentRoutes(router: Router, deps: AttachmentRouteDeps): void {
  const { config, services, authenticateUser, userRateLimit, planOf } = deps;
  // Status polling has its own limit so polling never eats the member's chat budget.
  const pollRateLimit = createPrincipalRateLimiter((req) => req.auth?.subject, 60);
  const rawBody = express.raw({ type: () => true, limit: config.attachments.maxBytes });
  const attachments = services.attachments;
  const ready = Boolean(attachments) && config.attachments.ready;

  router.post(
    '/api/member/product-connection-chat/attachments',
    authenticateUser,
    userRateLimit,
    async (req, res): Promise<void> => {
      if (!ready || !attachments) {
        res.status(503).json({ error: 'ATTACHMENTS_NOT_CONFIGURED' });
        return;
      }
      const subject = req.auth!.subject;
      let entitlement: ProEntitlement;
      try {
        entitlement = await planOf(req);
      } catch (error) {
        if (error instanceof ProStoreUnavailableError) {
          res.status(503).json({ error: 'ATTACHMENTS_TEMPORARILY_UNAVAILABLE' });
          return;
        }
        throw error;
      }
      if (entitlement.plan !== 'PRO') {
        res.status(403).json({ error: 'PRO_REQUIRED' });
        return;
      }
      const name = decodeFileName(req.get('x-attachment-name'));
      const declaredType = req.get('content-type') ?? '';
      const matchId = req.get('x-attachment-match-id')?.trim();
      const senderHeader = req.get('x-attachment-sender')?.trim();
      const sender: ExcerptSpeaker | undefined = senderHeader === 'self' || senderHeader === 'match' ? senderHeader : undefined;
      if (!name || !declaredType || (matchId !== undefined && (matchId.length < 1 || matchId.length > 256))
        || Boolean(matchId) !== Boolean(sender) || (senderHeader !== undefined && !sender)) {
        res.status(400).json({ error: 'INVALID_ATTACHMENT_REQUEST' });
        return;
      }

      try {
        await new Promise<void>((resolve, reject) => rawBody(req, res, (error?: unknown) => (error ? reject(error) : resolve())));
      } catch (error) {
        const type = (error as { type?: string } | undefined)?.type;
        if (type === 'entity.too.large') {
          res.status(413).json({ error: 'ATTACHMENT_TOO_LARGE' });
          return;
        }
        res.status(400).json({ error: 'INVALID_ATTACHMENT_REQUEST' });
        return;
      }
      const bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) {
        res.status(400).json({ error: 'INVALID_ATTACHMENT_REQUEST' });
        return;
      }
      const detected = detectAttachmentType(bytes, declaredType, name);
      if (!detected) {
        res.status(415).json({ error: 'UNSUPPORTED_ATTACHMENT_TYPE' });
        return;
      }
      if (!attachments.processor.supports(detected.reader)) {
        res.status(503).json({ error: 'ATTACHMENTS_NOT_CONFIGURED' });
        return;
      }

      try {
        if (matchId) {
          const match = await services.dataClient.getAiVisibleMatch(subject, matchId);
          if (sender === 'match' && !match.messageHistoryAllowed) {
            res.status(403).json({ error: 'MESSAGE_CONTEXT_NOT_ALLOWED' });
            return;
          }
        }
        const budgetMinor = entitlement.source === 'MEMBERSHIP'
          ? config.attachments.monthlyBudgetMinor.membership
          : config.attachments.monthlyBudgetMinor.subscription;
        const estimate = estimateCostMilli(detected.kind, detected.reader, bytes.length, config.attachments.rates, config.attachments.maxDocumentPages);
        const decision = await attachments.usage.reserve(subject, budgetMinor, estimate);
        if (!decision.allowed) {
          console.info('Attachment refused: processing allowance', { reason: decision.reason });
          res.status(429).json({ error: 'ATTACHMENT_PROCESSING_UNAVAILABLE', retryAt: decision.retryAt });
          return;
        }
        if (decision.crossedWarning && services.pro) {
          await services.pro.notify(subject, 'ATTACHMENT_USAGE_WARNING', `usage:${decision.month}`);
        }
        const now = new Date();
        const attachmentId = randomUUID();
        const record: AttachmentRecord = {
          schemaVersion: 1,
          attachmentId,
          userRef: stableReference(subject),
          name,
          kind: detected.kind,
          mediaType: detected.mediaType,
          reader: detected.reader,
          extension: detected.extension,
          sizeBytes: bytes.length,
          source: matchId ? 'match_chat' : 'upload',
          ...(sender ? { sender } : {}),
          ...(matchId ? { matchId } : {}),
          status: 'PROCESSING',
          place: matchId ? 'ephemeral' : 'pending',
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ATTACHMENT_TTL_MS).toISOString(),
          usage: { month: decision.month, reservedMilli: estimate, settled: false, budgetMinor },
          leaseUntil: new Date(now.getTime() + 3 * 60_000).toISOString(),
        };
        try {
          await attachments.store.create(subject, record, bytes);
        } catch (error) {
          await attachments.usage.settle(subject, decision.month, estimate, 0).catch(() => undefined);
          throw error;
        }
        attachments.queue.enqueue(subject, attachmentId, true);
        res.status(202).json({ attachment: toChatAttachment(record) });
      } catch (error) {
        if (error instanceof MatchContextAccessError) {
          res.status(404).json({ error: 'MATCH_NOT_AVAILABLE' });
          return;
        }
        if (error instanceof MatchContextUnavailableError) {
          res.status(503).json({ error: 'CONTEXT_TEMPORARILY_UNAVAILABLE' });
          return;
        }
        console.error('Attachment upload failed', {
          errorType: error instanceof AttachmentUsageUnavailableError ? 'UsageUnavailable' : error instanceof Error ? error.name : 'UnknownError',
        });
        res.status(503).json({ error: 'ATTACHMENTS_TEMPORARILY_UNAVAILABLE' });
      }
    },
  );

  router.get(
    '/api/member/product-connection-chat/attachments/:attachmentId',
    authenticateUser,
    pollRateLimit,
    async (req, res): Promise<void> => {
      if (!ready || !attachments) {
        res.status(503).json({ error: 'ATTACHMENTS_NOT_CONFIGURED' });
        return;
      }
      const attachmentId = pathParam(req, 'attachmentId');
      try {
        const found = isUuid(attachmentId) ? await attachments.store.get(req.auth!.subject, attachmentId) : undefined;
        if (!found) {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
        // Interrupted elsewhere (restart, deploy): take it over here.
        if (attachments.queue.isAbandoned(found.record)) attachments.queue.enqueue(req.auth!.subject, attachmentId);
        res.json({ attachment: toChatAttachment(found.record) });
      } catch (error) {
        if (error instanceof AttachmentAccessError) {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
        console.error('Attachment read failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
        res.status(503).json({ error: 'ATTACHMENTS_TEMPORARILY_UNAVAILABLE' });
      }
    },
  );

  router.get(
    '/api/member/product-connection-chat/attachments/:attachmentId/content',
    authenticateUser,
    userRateLimit,
    async (req, res): Promise<void> => {
      if (!ready || !attachments) {
        res.status(503).json({ error: 'ATTACHMENTS_NOT_CONFIGURED' });
        return;
      }
      const attachmentId = pathParam(req, 'attachmentId');
      try {
        const found = isUuid(attachmentId) ? await attachments.store.get(req.auth!.subject, attachmentId) : undefined;
        if (!found || found.record.source !== 'upload') {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
        const bytes = await attachments.store.content(req.auth!.subject, found.record);
        res.status(200)
          .set('Content-Type', found.record.mediaType)
          .set('Content-Disposition', contentDisposition(found.record.name))
          .set('X-Content-Type-Options', 'nosniff')
          .set('Cache-Control', 'private, no-store')
          .set('Content-Security-Policy', "default-src 'none'; sandbox")
          .send(bytes);
      } catch (error) {
        if (error instanceof AttachmentAccessError) {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
        console.error('Attachment content read failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
        res.status(503).json({ error: 'ATTACHMENTS_TEMPORARILY_UNAVAILABLE' });
      }
    },
  );
}
