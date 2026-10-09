import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AzureOpenAI } from 'openai';
import { createJwtAuthenticator, requirePermission } from './auth';
import type { ContextualFeatureConfig, ChatSessionTierPolicy } from './contextConfig';
import {
  ChatSessionAccessError,
  ChatSessionLimitError,
  type PlaintextChatSessionStore,
} from './plaintextChatSessionStore';
import {
  buildContextualSystemPrompt,
  parseContextualModelResponse,
  type ContextualModelResponse,
} from './contextPrompt';
import { parseContextualChatInput } from './contextTypes';
import {
  MatchContextAccessError,
  MatchContextUnavailableError,
  type OneHookDataClient,
} from './oneHookDataClient';

interface ContextualServices {
  client: AzureOpenAI;
  deployment: string;
  dataClient: OneHookDataClient;
  sessionStore: PlaintextChatSessionStore;
  productContextProvider: (query: string) => Promise<string>;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

function createPrincipalRateLimiter(
  keyForRequest: (req: Request) => string | undefined,
  limit: number,
  windowMs = 60_000,
  maxEntries = 10_000,
) {
  const entries = new Map<string, RateLimitEntry>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyForRequest(req);
    if (!key) {
      res.status(401).json({ error: 'AUTH_REQUIRED' });
      return;
    }
    const now = Date.now();
    for (const [entryKey, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(entryKey);
    }
    if (entries.size >= maxEntries && !entries.has(key)) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (oldestKey) entries.delete(oldestKey);
    }
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    existing.count += 1;
    if (existing.count > limit) {
      res.status(429).json({ error: 'RATE_LIMITED' });
      return;
    }
    next();
  };
}

function requestIdFor(req: Request): string {
  const idempotencyKey = req.get('idempotency-key');
  return idempotencyKey
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)
    ? idempotencyKey
    : randomUUID();
}

export function createContextualRouter(
  config: ContextualFeatureConfig,
  services?: ContextualServices,
): Router {
  const router = Router();
  const unavailableStatus = config.enabled ? 503 : 404;
  const unavailableError = config.enabled ? 'CONTEXT_NOT_CONFIGURED' : 'ENDPOINT_NOT_FOUND';

  if (!config.ready || !services) {
    router.post('/api/member/product-connection-chat', (_req, res) => {
      res.status(unavailableStatus).json({ error: unavailableError });
    });
    router.get('/api/member/product-connection-chat/sessions', (_req, res) => {
      res.status(unavailableStatus).json({ error: unavailableError });
    });
    router.get('/api/member/product-connection-chat/sessions/:sessionId', (_req, res) => {
      res.status(unavailableStatus).json({ error: unavailableError });
    });
    router.delete('/api/member/product-connection-chat/sessions/:sessionId', (_req, res) => {
      res.status(unavailableStatus).json({ error: unavailableError });
    });
    return router;
  }

  const authenticateUser = createJwtAuthenticator(config, config.authAudience);
  const userRateLimit = createPrincipalRateLimiter((req) => req.auth?.subject, 20);

  router.post(
    '/api/member/product-connection-chat',
    authenticateUser,
    requirePermission(config.userChatPermission),
    userRateLimit,
    async (req, res): Promise<void> => {
      const requestId = requestIdFor(req);
      let input;
      try {
        input = parseContextualChatInput(
          req.body,
          config.maxInputCharacters,
          config.maxEphemeralMessages,
          config.maxEphemeralCharacters,
        );
      } catch {
        res.status(400).json({ error: 'INVALID_CONTEXTUAL_CHAT_REQUEST', requestId });
        return;
      }

      try {
        const subject = req.auth!.subject;
        let sessionPolicy: ChatSessionTierPolicy | undefined;
        if (input.persistSession) {
          if (!config.sessionStorageReady) {
            res.status(503).json({ error: 'CHAT_SESSION_STORAGE_NOT_CONFIGURED', requestId });
            return;
          }
          sessionPolicy = req.auth!.tier
            ? config.sessionTierPolicies[req.auth!.tier]
            : undefined;
          if (!sessionPolicy) {
            res.status(403).json({ error: 'CHAT_SESSION_NOT_INCLUDED_IN_TIER', requestId });
            return;
          }
        }

        const match = input.matchId
          ? await services.dataClient.getAiVisibleMatch(subject, input.matchId)
          : undefined;
        const existingSession = input.sessionId
          ? await services.sessionStore.get(subject, input.sessionId)
          : undefined;
        if (input.sessionId && !existingSession) {
          res.status(404).json({ error: 'CHAT_SESSION_NOT_FOUND', requestId });
          return;
        }
        if (existingSession && existingSession.matchId !== input.matchId) {
          res.status(404).json({ error: 'CHAT_SESSION_NOT_FOUND', requestId });
          return;
        }

        if (input.ephemeralMessageContext && (!match || !match.messageHistoryAllowed)) {
          res.status(403).json({ error: 'MESSAGE_CONTEXT_NOT_ALLOWED', requestId });
          return;
        }
        const productContext = await services.productContextProvider(input.message);
        const excerpts = match && match.messageHistoryAllowed && input.includeMessageHistory
          ? input.ephemeralMessageContext?.excerpts ?? []
          : [];
        const { prompt, contextUsed } = buildContextualSystemPrompt(
          match,
          input,
          excerpts,
          existingSession && sessionPolicy
            ? existingSession.messages.slice(-(sessionPolicy.maxMessages - (sessionPolicy.maxMessages % 2)))
            : [],
          productContext,
          config.contextRequestMaxMessages,
        );
        const completion = await services.client.chat.completions.create({
          model: services.deployment,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: input.message },
          ],
          response_format: { type: 'json_object' },
        });
        const responseText = completion.choices[0]?.message?.content;
        if (!responseText) throw new Error('Model returned no content');
        const parsedResult = parseContextualModelResponse(responseText, config.contextRequestMaxMessages);
        const result: ContextualModelResponse = !input.matchId && parsedResult.needsMoreContext
          ? { reply: parsedResult.reply, mood: parsedResult.mood }
          : parsedResult;
        const storedSession = sessionPolicy && !parsedResult.needsMoreContext
          ? await services.sessionStore.appendExchange({
              subject,
              ...(input.matchId ? { matchId: input.matchId } : {}),
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              exchangeId: requestId,
              userMessage: input.message,
              assistantMessage: result.reply,
              policy: sessionPolicy,
            })
          : undefined;
        const responseResult = result.needsMoreContext && result.contextRequest
          ? { ...result, contextRequest: { ...result.contextRequest, requestId } }
          : result;
        res.json({
          ...responseResult,
          contextUsed,
          requestId,
          ...(storedSession
            ? {
                session: {
                  sessionId: storedSession.sessionId,
                  updatedAt: storedSession.updatedAt,
                  expiresAt: storedSession.expiresAt,
                  messageCount: storedSession.messages.length,
                },
              }
            : {}),
        });
      } catch (error: unknown) {
        if (error instanceof ChatSessionAccessError) {
          res.status(404).json({ error: 'CHAT_SESSION_NOT_FOUND', requestId });
          return;
        }
        if (error instanceof ChatSessionLimitError) {
          res.status(409).json({ error: 'CHAT_SESSION_LIMIT_REACHED', requestId });
          return;
        }
        if (error instanceof MatchContextAccessError) {
          res.status(404).json({ error: 'MATCH_NOT_AVAILABLE', requestId });
          return;
        }
        if (error instanceof MatchContextUnavailableError) {
          res.status(503).json({ error: 'CONTEXT_TEMPORARILY_UNAVAILABLE', requestId });
          return;
        }
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status: unknown }).status)
          : 0;
        if (status === 429) {
          res.status(429).json({ error: 'AI_RATE_LIMITED', requestId });
          return;
        }
        console.error('Contextual chat request failed', {
          requestId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        res.status(503).json({ error: 'CONTEXT_TEMPORARILY_UNAVAILABLE', requestId });
      }
    },
  );

  router.get(
    '/api/member/product-connection-chat/sessions',
    authenticateUser,
    requirePermission(config.userChatPermission),
    userRateLimit,
    async (req, res): Promise<void> => {
      try {
        const sessions = await services.sessionStore.list(req.auth!.subject);
        res.json({ sessions });
      } catch (error: unknown) {
        console.error('Chat session list failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        res.status(503).json({ error: 'CHAT_SESSION_STORAGE_TEMPORARILY_UNAVAILABLE' });
      }
    },
  );

  router.get(
    '/api/member/product-connection-chat/sessions/:sessionId',
    authenticateUser,
    requirePermission(config.userChatPermission),
    userRateLimit,
    async (req, res): Promise<void> => {
      const policy = req.auth!.tier ? config.sessionTierPolicies[req.auth!.tier] : undefined;
      if (!config.sessionStorageReady) {
        res.status(503).json({ error: 'CHAT_SESSION_STORAGE_NOT_CONFIGURED' });
        return;
      }
      if (!policy) {
        res.status(403).json({ error: 'CHAT_SESSION_NOT_INCLUDED_IN_TIER' });
        return;
      }
      try {
        const pathSessionId = Array.isArray(req.params.sessionId) ? '' : (req.params.sessionId ?? '');
        const session = await services.sessionStore.get(req.auth!.subject, pathSessionId);
        if (!session) {
          res.status(404).json({ error: 'CHAT_SESSION_NOT_FOUND' });
          return;
        }
        if (session.matchId) {
          await services.dataClient.getAiVisibleMatch(req.auth!.subject, session.matchId);
        }
        res.json({
          session: {
            sessionId: session.sessionId,
            ...(session.matchId ? { matchId: session.matchId } : {}),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            expiresAt: session.expiresAt,
            messages: session.messages
              .slice(-(policy.maxMessages - (policy.maxMessages % 2)))
              .map(({ role, content, createdAt }) => ({
              role,
              content,
              createdAt,
            })),
          },
        });
      } catch (error: unknown) {
        if (error instanceof ChatSessionAccessError || error instanceof MatchContextAccessError) {
          res.status(404).json({ error: 'CHAT_SESSION_NOT_FOUND' });
          return;
        }
        console.error('Chat session read failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        res.status(503).json({ error: 'CHAT_SESSION_STORAGE_TEMPORARILY_UNAVAILABLE' });
      }
    },
  );

  router.delete(
    '/api/member/product-connection-chat/sessions/:sessionId',
    authenticateUser,
    requirePermission(config.userChatPermission),
    userRateLimit,
    async (req, res): Promise<void> => {
      try {
        const pathSessionId = Array.isArray(req.params.sessionId) ? '' : (req.params.sessionId ?? '');
        await services.sessionStore.delete(req.auth!.subject, pathSessionId);
        res.status(204).send();
      } catch (error: unknown) {
        if (error instanceof ChatSessionAccessError) {
          res.status(404).json({ error: 'CHAT_SESSION_NOT_FOUND' });
          return;
        }
        console.error('Chat session delete failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        res.status(503).json({ error: 'CHAT_SESSION_STORAGE_TEMPORARILY_UNAVAILABLE' });
      }
    },
  );

  return router;
}
