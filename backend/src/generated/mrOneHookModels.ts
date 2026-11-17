// GENERATED FILE - DO NOT EDIT.
// Source of truth: OneHookUXEnhancement/sdk/model/*.smithy (Smithy MrOneHookService), via its OpenAPI.
// Regenerate: (OneHookUXEnhancement/sdk) npm run build && npm run manifest:sync
/* eslint-disable */

/** Every MrOneHookService operation. */
export const OPERATIONS = [
  { operationId: "DeleteChatSession", method: "DELETE", path: "/api/member/product-connection-chat/sessions/{sessionId}" },
  { operationId: "GetChatSession", method: "GET", path: "/api/member/product-connection-chat/sessions/{sessionId}" },
  { operationId: "GetHealth", method: "GET", path: "/health" },
  { operationId: "ListChatSessions", method: "GET", path: "/api/member/product-connection-chat/sessions" },
  { operationId: "ProductConnectionChat", method: "POST", path: "/api/member/product-connection-chat" },
  { operationId: "PublicProductChat", method: "POST", path: "/api/public/product-chat" },
] as const;

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface BadRequestErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export interface ChatSessionDetail {
  sessionId: string;
  /** Connection sessions only. */
  matchId?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /** ISO-8601. */
  expiresAt: string;
  messages: ChatSessionMessage[];
}

/**
 * 409 `CHAT_SESSION_LIMIT_REACHED`: a new saved session would exceed the tier's cap. Before the model
 * call it lists the sessions so the app can offer a choice; a race at save time carries neither field.
 */
export interface ChatSessionLimitReachedErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
  maxSessions?: number;
  sessions?: ChatSessionSummary[];
}

export interface ChatSessionMessage {
  role: ChatSessionRole;
  content: string;
  /** ISO-8601. */
  createdAt: string;
}

export type ChatSessionRole = "user" | "assistant";

export type ChatSessionScope = "product" | "connection";

export interface ChatSessionSummary {
  sessionId: string;
  scope: ChatSessionScope;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /** ISO-8601. */
  expiresAt: string;
  messageCount: number;
}

/** At least one bound; `from` is not after `to`. */
export interface ContextDateRange {
  /** ISO-8601. */
  from?: string;
  /** ISO-8601. */
  to?: string;
}

export interface ContextOptions {
  /** Default true. */
  includeProfile?: boolean;
  /** Default true. */
  includeMessageHistory?: boolean;
}

export interface ContextRequest {
  /** 1 to 8 terms, each 1 to 80 characters. */
  searchTerms: string[];
  /** 1 to `CONTEXT_REQUEST_MAX_MESSAGES` (default 8). */
  maxMessages: number;
  dateRange?: ContextDateRange;
  /** The turn's `requestId`; send it back as `contextRequestId`. */
  requestId: string;
}

/** Which context went into the answer. */
export interface ContextUsed {
  profile: boolean;
  match: boolean;
  messageHistory: boolean;
  messageCount: number;
  chatSession: boolean;
  sessionMessageCount: number;
}

export interface EphemeralMessageContext {
  /**
   * 1 to `EPHEMERAL_CONTEXT_MAX_MESSAGES` (default 30); total text at most
   * `EPHEMERAL_CONTEXT_MAX_CHARACTERS` (default 12000).
   */
  excerpts: EphemeralMessageExcerpt[];
  historyTruncated?: boolean;
  userConfirmed?: boolean;
}

export interface EphemeralMessageExcerpt {
  speaker: ExcerptSpeaker;
  /** ISO-8601, at most 5 minutes in the future. */
  sentAt: string;
  text: string;
}

export type ExcerptSpeaker = "self" | "match";

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface ForbiddenErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export interface GetChatSessionResponseContent {
  session: ChatSessionDetail;
}

export interface GetHealthResponseContent {
  /** Always `ok`. */
  status: string;
  /** ISO-8601. */
  timestamp: string;
}

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface InternalServerErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export interface ListChatSessionsResponseContent {
  sessions: ChatSessionSummary[];
}

/** What happened to a "find me ..." request. The prompt Mr OneHook wrote is never returned. */
export interface MatchSuggestionResult {
  status: SuggestionStatus;
  /** Why Mr OneHook is suggesting these people (1 to 280 characters). */
  reasoning: string;
}

/** 402 `MESSAGE_LIMIT_REACHED`: the free tier's daily messages are spent. */
export interface MessageLimitReachedErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
  /** Always 0. */
  remainingMessages: number;
}

/** Mr OneHook's mood, which drives the mascot's face. */
export type Mood = "Happy" | "Neutral" | "Thinking" | "Sad" | "Excited";

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface NotFoundErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

/** 413 `PAYLOAD_TOO_LARGE`: the JSON body is over 32 KB. */
export interface PayloadTooLargeErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export interface ProductConnectionChatRequestContent {
  /** 1 to `CONTEXT_MAX_INPUT_CHARACTERS` (default 4000) characters; trimmed, must not be blank. */
  message: string;
  /** Present: a connection chat about this match (1 to 256 characters). Absent: a product chat. */
  matchId?: string;
  contextOptions?: ContextOptions;
  ephemeralMessageContext?: EphemeralMessageContext;
  /** UUID of a `contextRequest` this turn answers. */
  contextRequestId?: string;
  sessionOptions?: SessionOptions;
}

export interface ProductConnectionChatResponseContent {
  /** 1 to 8000 characters. */
  reply: string;
  mood: Mood;
  /** Connection chats only: Mr OneHook needs more of the conversation; `contextRequest` says what. */
  needsMoreContext?: boolean;
  contextRequest?: ContextRequest;
  /** Free tier only: messages left today after this one. */
  remainingMessages?: number;
  matchSuggestion?: MatchSuggestionResult;
  contextUsed: ContextUsed;
  /** UUID of this turn. */
  requestId: string;
  session?: SavedSessionRef;
}

export interface PublicChatMessage {
  role: PublicChatRole;
  content: string;
}

export type PublicChatRole = "system" | "user" | "assistant";

export interface PublicProductChatRequestContent {
  /** The conversation so far; the last message is the visitor's. */
  messages: PublicChatMessage[];
  userDemographics?: UserDemographics;
  /** Bot trap: must be absent or empty. */
  honeypot?: string;
}

export interface PublicProductChatResponseContent {
  reply: string;
  mood: Mood;
}

export interface SavedSessionRef {
  sessionId: string;
  /** ISO-8601. */
  updatedAt: string;
  /** ISO-8601. */
  expiresAt: string;
  messageCount: number;
}

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface ServiceUnavailableErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

/** Saving the conversation needs a paid tier (403 `CHAT_SESSION_NOT_INCLUDED_IN_TIER` otherwise). */
export interface SessionOptions {
  /** Start a saved session. */
  persist?: boolean;
  /** Continue this saved session (UUID). Cannot be combined with `persist: false`. */
  sessionId?: string;
  /** At the tier's session cap, delete the least recently active session instead of answering 409. */
  replaceLeastRecent?: boolean;
}

export type SuggestionStatus = "RECORDED" | "PREMIUM_REQUIRED" | "MATCHING_OFF" | "UNAVAILABLE";

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface TooManyRequestsErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface UnauthorizedErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export interface UserDemographics {
  gender?: string;
  sexualPreference?: string;
}
