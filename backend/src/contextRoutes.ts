import { Router, type Request } from 'express';
import type { AzureOpenAI } from 'openai';
import { createJwtAuthenticator } from './auth';
import { FREE_DAILY_MESSAGES, QuotaUnavailableError, unavailableChatQuota, type ChatQuota } from './chatQuota';
import type { ContextualFeatureConfig, ChatSessionPlanPolicy } from './contextConfig';
import {
  ChatSessionAccessError,
  ChatSessionLimitError,
  type PlaintextChatSessionStore,
  type StoredAttachmentRef,
} from './plaintextChatSessionStore';
import {
  buildContextualSystemPrompt,
  parseContextualModelResponse,
  type ContextualModelResponse,
  type PromptAttachment,
} from './contextPrompt';
import { parseContextualChatInput } from './contextTypes';
import type { ChatSessionDetail, MrOneHookPlan } from './generated/mrOneHookModels';
import { disabledSuggestionRecorder, type SuggestionRecorder, type SuggestionStatus } from './matchingSuggestionClient';
import {
  MatchContextAccessError,
  MatchContextUnavailableError,
  type OneHookDataClient,
} from './oneHookDataClient';
import { createPrincipalRateLimiter, pathParam, requestIdFor, resolveEntitlement } from './memberRouting';
import { ProStoreUnavailableError } from './proStore';
import type { ProSubscriptionService } from './proSubscriptionService';
import type { AttachmentStore, StoredAttachment } from './attachmentStore';
import type { AttachmentProcessingQueue, AttachmentProcessor } from './attachmentProcessor';
import {
  PROMPT_ATTACHMENT_CHARACTERS,
  PROMPT_CHARACTERS_PER_ATTACHMENT,
  SESSION_EXCERPT_CHARACTERS,
} from './attachmentProcessor';
import type { AttachmentUsageLedger } from './attachmentUsage';
import { registerAttachmentRoutes, registerUnavailableAttachmentRoutes } from './attachmentRoutes';
import { registerProRoutes, registerUnavailableProRoutes } from './proRoutes';

export interface AttachmentServices {
  store: AttachmentStore;
  queue: AttachmentProcessingQueue;
  processor: AttachmentProcessor;
  usage: AttachmentUsageLedger;
}

export interface ContextualServices {
  client: AzureOpenAI;
  /** Free plan daily message allowance (Azure Table Storage). Pro never uses it. */
  chatQuota?: ChatQuota;
  /** Records OneHook suggestions in Matching (AWS) with the member's token. */
  suggestionRecorder?: SuggestionRecorder;
  deployment: string;
  dataClient: OneHookDataClient;
  sessionStore: PlaintextChatSessionStore;
  productContextProvider: (query: string) => Promise<string>;
  /** Mr OneHook Pro subscriptions. Absent: only the membership decides the plan. */
  pro?: ProSubscriptionService;
  /** Chat attachments. Absent: attachment routes answer 503 `ATTACHMENTS_NOT_CONFIGURED`. */
  attachments?: AttachmentServices;
}

/** Answer of a check that ends the request. */
class Refusal extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
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
    registerUnavailableAttachmentRoutes(router, unavailableStatus, unavailableError);
    registerUnavailableProRoutes(router, unavailableStatus, unavailableError);
    return router;
  }

  const authenticateUser = createJwtAuthenticator(config, config.authAudience);
  // One budget for every member route (chat, sessions, attachments, Pro): 20 requests per minute.
  const userRateLimit = createPrincipalRateLimiter((req) => req.auth?.subject, 20);
  const planOf = (req: Request) => resolveEntitlement(config, services.pro, req.auth!.subject, req.auth!.membership);
  const policyOf = (plan: MrOneHookPlan): ChatSessionPlanPolicy | undefined => config.sessionPlanPolicies[plan];

  /**
   * Makes room for one new saved session: deletes the least recently active ones until the member is
   * below the plan's cap (Free 1: the previous session is replaced; Pro 3: the LRU one goes). Sessions the
   * member deleted themselves are already gone, so nothing else is touched.
   */
  async function makeRoom(subject: string, policy: ChatSessionPlanPolicy, requestId: string): Promise<string[]> {
    const current = await services!.sessionStore.list(subject);
    if (current.length < policy.maxSessions) return [];
    const evicted: string[] = [];
    // list() is newest first: drop from the end until there is room for one more.
    for (const old of current.slice(policy.maxSessions - 1).reverse()) {
      await services!.sessionStore.delete(subject, old.sessionId);
      evicted.push(old.sessionId);
    }
    console.info('Replaced least recent chat sessions', { requestId, count: evicted.length });
    return evicted;
  }

  router.post(
    '/api/member/product-connection-chat',
    authenticateUser,
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
          config.attachments.maxPerMessage,
        );
      } catch {
        res.status(400).json({ error: 'INVALID_CONTEXTUAL_CHAT_REQUEST', requestId });
        return;
      }

      let quotaTaken = false;
      try {
        const subject = req.auth!.subject;
        const entitlement = await planOf(req);
        const plan = entitlement.plan;
        let sessionPolicy: ChatSessionPlanPolicy | undefined;
        if (input.persistSession) {
          if (!config.sessionStorageReady) {
            res.status(503).json({ error: 'CHAT_SESSION_STORAGE_NOT_CONFIGURED', requestId });
            return;
          }
          sessionPolicy = policyOf(plan);
          if (!sessionPolicy) {
            res.status(403).json({ error: 'CHAT_SESSION_NOT_INCLUDED_IN_TIER', requestId });
            return;
          }
        }
        if (input.attachmentIds.length > 0) {
          if (!services.attachments || !config.attachments.ready) throw new Refusal(503, 'ATTACHMENTS_NOT_CONFIGURED');
          if (plan !== 'PRO') throw new Refusal(403, 'PRO_REQUIRED');
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

        // The files of this turn: the member's own, READY, and match-chat files only in that match's chat.
        const attachments: StoredAttachment[] = [];
        for (const attachmentId of input.attachmentIds) {
          const found = await services.attachments!.store.get(subject, attachmentId);
          if (!found) throw new Refusal(404, 'ATTACHMENT_NOT_FOUND');
          const record = found.record;
          if (record.status === 'PROCESSING') {
            if (services.attachments!.queue.isAbandoned(record)) services.attachments!.queue.enqueue(subject, attachmentId);
            throw new Refusal(409, 'ATTACHMENT_NOT_READY');
          }
          if (record.status === 'FAILED' || record.place === 'saved') throw new Refusal(400, 'ATTACHMENT_NOT_USABLE');
          if (record.source === 'match_chat') {
            if (record.matchId !== input.matchId || !match) throw new Refusal(400, 'ATTACHMENT_NOT_USABLE');
            if (record.sender === 'match' && (!match.messageHistoryAllowed || !input.includeMessageHistory)) {
              throw new Refusal(403, 'MESSAGE_CONTEXT_NOT_ALLOWED');
            }
          }
          attachments.push(found);
        }

        if (input.ephemeralMessageContext && (!match || !match.messageHistoryAllowed)) {
          res.status(403).json({ error: 'MESSAGE_CONTEXT_NOT_ALLOWED', requestId });
          return;
        }
        // Free plan: 10 messages per UTC day; Pro unlimited. The plan comes from the verified token and the
        // Pro table, never the client. The slot is taken before the model call and given back if it fails.
        let remainingMessages: number | undefined;
        if (plan === 'FREE') {
          const decision = await (services.chatQuota ?? unavailableChatQuota).consume(subject);
          if (!decision.allowed) {
            res.status(402).json({ error: 'MESSAGE_LIMIT_REACHED', remainingMessages: 0, requestId });
            return;
          }
          remainingMessages = decision.remaining;
          quotaTaken = true;
        }
        const productContext = await services.productContextProvider(input.message);
        const excerpts = match && match.messageHistoryAllowed && input.includeMessageHistory
          ? input.ephemeralMessageContext?.excerpts ?? []
          : [];
        let promptBudget = PROMPT_ATTACHMENT_CHARACTERS;
        const promptAttachments: PromptAttachment[] = attachments.map(({ record }) => {
          const full = record.extracted?.text ?? '';
          const allowed = Math.max(0, Math.min(PROMPT_CHARACTERS_PER_ATTACHMENT, promptBudget));
          promptBudget -= Math.min(full.length, allowed);
          return {
            name: record.name,
            kind: record.kind,
            sharedBy: record.source === 'match_chat' && record.sender === 'match' ? 'your match' : 'you',
            content: full.slice(0, allowed),
            truncated: Boolean(record.extracted?.truncated) || full.length > allowed,
          };
        });
        const { prompt, contextUsed } = buildContextualSystemPrompt(
          match,
          input,
          excerpts,
          existingSession && sessionPolicy
            ? existingSession.messages.slice(-(sessionPolicy.maxMessages - (sessionPolicy.maxMessages % 2)))
            : [],
          productContext,
          config.contextRequestMaxMessages,
          promptAttachments,
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
        const finalAnswer = !parsedResult.needsMoreContext;

        // What the saved turn keeps of its files: uploads keep an id and an excerpt; match-chat files keep
        // only their name and kind (their content is never stored).
        const userAttachments: StoredAttachmentRef[] = attachments.map(({ record }) => record.source === 'upload'
          ? {
              attachmentId: record.attachmentId, name: record.name, kind: record.kind, sizeBytes: record.sizeBytes, source: record.source,
              ...(record.extracted?.text ? { excerpt: record.extracted.text.slice(0, SESSION_EXCERPT_CHARACTERS) } : {}),
            }
          : { name: record.name, kind: record.kind, source: record.source });
        const append = () => services.sessionStore.appendExchange({
          subject,
          ...(input.matchId ? { matchId: input.matchId } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          exchangeId: requestId,
          userMessage: input.message,
          assistantMessage: result.reply,
          assistantMood: result.mood,
          ...(userAttachments.length > 0 ? { userAttachments } : {}),
          policy: sessionPolicy!,
        });
        // A NEW saved session at the plan's cap replaces the least recently active one(s), only once there is
        // an answer to save (a failed model call or a clarification deletes nothing). The store's index
        // re-checks the cap on save; a concurrent request that took the slot meanwhile is handled once more.
        const evictedSessionIds: string[] = [];
        let storedSession;
        if (sessionPolicy && finalAnswer) {
          if (!existingSession) evictedSessionIds.push(...await makeRoom(subject, sessionPolicy, requestId));
          try {
            storedSession = await append();
          } catch (error) {
            // A concurrent request filled the plan's last slot meanwhile: make room again, once.
            if (!(error instanceof ChatSessionLimitError) || existingSession) throw error;
            evictedSessionIds.push(...await makeRoom(subject, sessionPolicy, requestId));
            storedSession = await append();
          }
        }
        // Files are used once. Uploads move into the saved session (deleted with it) or are deleted;
        // match-chat files are always deleted. A clarification (needsMoreContext) keeps them for the retry.
        if (finalAnswer && attachments.length > 0) {
          for (const stored of attachments) {
            const keep = storedSession && stored.record.source === 'upload';
            try {
              if (keep) await services.attachments!.store.save(subject, stored, storedSession!.sessionId, storedSession!.expiresAt);
              else await services.attachments!.store.delete(subject, stored.record.attachmentId);
            } catch (error) {
              console.error('Attachment finalize failed', { requestId, errorType: error instanceof Error ? error.name : 'UnknownError' });
            }
          }
        }
        // "OneHook, find me ...": record the suggestion in Matching so matching people appear in the
        // member's discover feed. Only from product chats: in a connection chat the model also sees the
        // other person's messages, which must never be able to plant suggestions in this member's feed.
        // The call is signed with this service's AWS role and carries the member's token as proof; the
        // member id and tier come only from that token. The prompt stays server-side.
        let matchSuggestion: { status: SuggestionStatus; reasoning: string } | undefined;
        if (result.matchSuggestion && !input.matchId) {
          // The member's own token (already verified above) is sent as PROOF of their session; Matching
          // re-verifies it and derives the member id and tier only from it. The verified subject is the
          // member whose matching mode must be ON before anything is recorded.
          const memberIdToken = (req.headers.authorization ?? '').slice('Bearer '.length).trim();
          const status = await (services.suggestionRecorder ?? disabledSuggestionRecorder)
            .record({ userId: subject, idToken: memberIdToken }, result.matchSuggestion);
          matchSuggestion = { status, reasoning: result.matchSuggestion.reasoning };
          console.info('OneHook suggestion', { requestId, status });
        }
        const { matchSuggestion: _internal, ...publicResult } = result;
        const responseResult = publicResult.needsMoreContext && publicResult.contextRequest
          ? { ...publicResult, contextRequest: { ...publicResult.contextRequest, requestId } }
          : publicResult;
        quotaTaken = false; // answered: the message is spent
        res.json({
          ...responseResult,
          ...(remainingMessages !== undefined ? { remainingMessages } : {}),
          ...(matchSuggestion ? { matchSuggestion } : {}),
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
          ...(evictedSessionIds.length > 0 ? { evictedSessionIds } : {}),
          plan,
        });
      } catch (error: unknown) {
        if (quotaTaken) await (services.chatQuota ?? unavailableChatQuota).release(req.auth!.subject);
        if (error instanceof Refusal) {
          res.status(error.status).json({ error: error.code, requestId });
          return;
        }
        if (error instanceof QuotaUnavailableError || error instanceof ProStoreUnavailableError) {
          console.error('Chat plan or quota store unavailable', { requestId, errorType: error.name });
          res.status(503).json({ error: 'CHAT_TEMPORARILY_UNAVAILABLE', requestId });
          return;
        }
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
    userRateLimit,
    async (req, res): Promise<void> => {
      if (!config.sessionStorageReady) {
        res.status(503).json({ error: 'CHAT_SESSION_STORAGE_NOT_CONFIGURED' });
        return;
      }
      try {
        const policy = policyOf((await planOf(req)).plan);
        if (!policy) {
          res.status(403).json({ error: 'CHAT_SESSION_NOT_INCLUDED_IN_TIER' });
          return;
        }
        const session = await services.sessionStore.get(req.auth!.subject, pathParam(req, 'sessionId'));
        if (!session) {
          res.status(404).json({ error: 'CHAT_SESSION_NOT_FOUND' });
          return;
        }
        if (session.matchId) {
          await services.dataClient.getAiVisibleMatch(req.auth!.subject, session.matchId);
        }
        const messages = session.messages
          .slice(-(policy.maxMessages - (policy.maxMessages % 2)))
          .map(({ role, content, createdAt, mood, attachments }) => ({
            role,
            content,
            createdAt,
            ...(mood ? { mood } : {}),
            // The excerpt is for the model only; the app gets the reference.
            ...(attachments && attachments.length > 0
              ? { attachments: attachments.map(({ excerpt: _excerpt, ...ref }) => ref) }
              : {}),
          }));
        const detail: ChatSessionDetail = {
          sessionId: session.sessionId,
          scope: session.matchId ? 'connection' : 'product',
          ...(session.matchId ? { matchId: session.matchId } : {}),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt,
          messageCount: messages.length,
          messages,
        };
        res.json({ session: detail });
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
    userRateLimit,
    async (req, res): Promise<void> => {
      try {
        await services.sessionStore.delete(req.auth!.subject, pathParam(req, 'sessionId'));
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

  registerAttachmentRoutes(router, { config, services, authenticateUser, userRateLimit, planOf });
  registerProRoutes(router, { config, services, authenticateUser, userRateLimit, planOf, policyOf, freeDailyMessages: FREE_DAILY_MESSAGES });

  return router;
}
